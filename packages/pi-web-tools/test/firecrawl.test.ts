/**
 * Tests for the Firecrawl adapter (search/api/firecrawl.ts): the keyless →
 * keyed quota escalation, param mapping, and the both-filters compilation.
 * HTTP is stubbed at the global fetch boundary.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchWithFirecrawl } from "../search/api/firecrawl.js";
import type { WebSearchParams } from "../types.js";

interface Capture {
	headers?: Record<string, string>;
	body?: Record<string, unknown>;
	status: number;
}

function withEnv(key: string | undefined, fn: () => Promise<void>): Promise<void> {
	if (key === undefined) delete process.env.FIRECRAWL_API_KEY;
	else process.env.FIRECRAWL_API_KEY = key;
	return fn().finally(() => delete process.env.FIRECRAWL_API_KEY);
}

/** Sequential scripted responses — one entry per fetch call. */
function stubFetch(script: Array<{ status: number; body?: unknown }>, captures: Capture[] = []): void {
	let call = 0;
	globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
		const step = script[Math.min(call, script.length - 1)] ?? script[0];
		if (!step) return new Response("{}", { status: 500 });
		captures.push({
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: JSON.parse((init?.body as string) ?? "{}"),
			status: step.status,
		});
		call++;
		return new Response(JSON.stringify(step.body ?? {}), { status: step.status });
	}) as typeof fetch;
}

const OK = {
	status: 200,
	body: { data: { web: [{ title: "T", url: "https://a.dev", description: "d" }] } },
};

describe("firecrawl adapter", () => {
	it("keyless first: no auth header, keyed pool untouched", async () => {
		await withEnv(undefined, async () => {
			const captures: Capture[] = [];
			stubFetch([OK], captures);
			const results = await searchWithFirecrawl({ query: "q" }, {});
			assert.equal(captures[0]?.headers?.Authorization, undefined);
			assert.equal(results[0]?.url, "https://a.dev");
		});
	});

	it("keyless 429 escalates to the keyed pool when a key exists", async () => {
		await withEnv("fc-key", async () => {
			const captures: Capture[] = [];
			stubFetch([{ status: 429 }, OK], captures);
			await searchWithFirecrawl({ query: "q" }, {});
			assert.equal(captures[0]?.headers?.Authorization, undefined);
			assert.equal(captures[1]?.headers?.Authorization, "Bearer fc-key");
		});
	});

	it("keyless 429 without a key: terse LLM message, config hint separate", async () => {
		await withEnv(undefined, async () => {
			stubFetch([{ status: 429 }]);
			const err = await searchWithFirecrawl({ query: "q" }, {}).then(
				() => null,
				(e: unknown) => e as Error & { hint?: string },
			);
			assert.ok(err, "must reject");
			assert.match(err.message, /quota exhausted/);
			assert.ok(!err.message.includes("FIRECRAWL_API_KEY"), "no config guidance in LLM text");
			assert.match(err.hint ?? "", /FIRECRAWL_API_KEY/);
		});
	});

	it("allowed+blocked compile to includeDomains + -site: operators (both intents)", async () => {
		await withEnv(undefined, async () => {
			const captures: Capture[] = [];
			stubFetch([OK], captures);
			const params: WebSearchParams = {
				query: "rust cli",
				allowed_domains: ["github.com"],
				blocked_domains: ["reddit.com", "pinterest.com"],
			};
			await searchWithFirecrawl(params, {});
			const body = captures[0]?.body ?? {};
			assert.deepEqual(body.includeDomains, ["github.com"]);
			assert.equal(body.excludeDomains, undefined);
			assert.equal(body.query, "rust cli -site:reddit.com -site:pinterest.com");
		});
	});

	it("blocked-only goes through excludeDomains", async () => {
		await withEnv(undefined, async () => {
			const captures: Capture[] = [];
			stubFetch([OK], captures);
			await searchWithFirecrawl({ query: "q", blocked_domains: ["reddit.com"] }, {});
			assert.deepEqual(captures[0]?.body?.excludeDomains, ["reddit.com"]);
			assert.equal(captures[0]?.body?.includeDomains, undefined);
			assert.equal(captures[0]?.body?.query, "q");
		});
	});

	it("recency maps to tbs and locale maps to country", async () => {
		await withEnv(undefined, async () => {
			const captures: Capture[] = [];
			stubFetch([OK], captures);
			await searchWithFirecrawl({ query: "q", recency: "month", locale: "zh-CN" }, {});
			assert.equal(captures[0]?.body?.tbs, "qdr:m");
			assert.equal(captures[0]?.body?.country, "CN");
		});
	});
});
