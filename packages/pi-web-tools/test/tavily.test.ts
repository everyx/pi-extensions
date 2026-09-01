/**
 * Tests for the Tavily adapter (search/api/tavily.ts): param mapping
 * (domains, recency, locale → country/language) and the response mapping.
 * HTTP is stubbed at the global fetch boundary.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchWithTavily } from "../search/api/tavily.js";
import { recencyToTavily } from "../search/recency.js";

interface Capture {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

let script: Array<{ status?: number; body?: unknown }> = [];
const captures: Capture[] = [];
let call = 0;

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
	const step = script[Math.min(call, script.length - 1)] ?? script[0];
	captures.push({
		url: String(input),
		headers: (init?.headers ?? {}) as Record<string, string>,
		body: JSON.parse((init?.body as string) ?? "{}"),
	});
	call++;
	return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
}) as typeof fetch;

function withEnv(key: string | undefined, fn: () => Promise<void>): Promise<void> {
	if (key === undefined) delete process.env.TAVILY_API_KEY;
	else process.env.TAVILY_API_KEY = key;
	return fn().finally(() => delete process.env.TAVILY_API_KEY);
}

function reset(step: (typeof script)[number]): void {
	script = [step];
	captures.length = 0;
	call = 0;
}

describe("tavily adapter", () => {
	it("maps the full param surface onto the request", async () => {
		await withEnv("tv-key", async () => {
			reset({ body: { results: [] } });
			await searchWithTavily(
				{ query: "q", allowed_domains: ["a.com"], blocked_domains: ["b.com"], recency: "week", locale: "zh-CN" },
				{},
			);
			const c = captures[0];
			assert.equal(c.url, "https://api.tavily.com/search");
			assert.equal(c.headers.Authorization, "Bearer tv-key");
			assert.equal(c.body.query, "q");
			assert.equal(c.body.max_results, 5);
			assert.deepEqual(c.body.include_domains, ["a.com"]);
			assert.deepEqual(c.body.exclude_domains, ["b.com"]);
			assert.equal(c.body.time_range, recencyToTavily("week"), "recency via the single-source mapper");
			assert.equal(c.body.country, "china", "CN maps to Tavily's English country name");
			assert.equal(c.body.language, "zh");
		});
	});

	it("unmapped country codes skip the boost (no silent guess)", async () => {
		await withEnv("tv-key", async () => {
			reset({ body: { results: [] } });
			await searchWithTavily({ query: "q", locale: "en-XX" }, {});
			assert.equal(captures[0].body.country, undefined);
			assert.equal(captures[0].body.language, "en");
		});
	});

	it("maps the response (content → snippet collapsed, date → pageAge, url filter)", async () => {
		await withEnv("tv-key", async () => {
			reset({
				body: {
					results: [
						{ title: "T", url: "https://t.com", content: "multi   line\ncontent", publishedDate: "2026-08-25" },
						{ title: "no url", content: "x" },
					],
				},
			});
			const results = await searchWithTavily({ query: "q" }, {});
			assert.equal(results.length, 1, "results without url are dropped");
			assert.equal(results[0].snippet, "multi line content");
			assert.equal(typeof results[0].pageAge, "string");
		});
	});

	it("HTTP error → terse message with status", async () => {
		await withEnv("tv-key", async () => {
			reset({ status: 500, body: {} });
			await assert.rejects(() => searchWithTavily({ query: "q" }, {}), /Tavily error 500/);
		});
	});

	it("missing key → explicit error (no request)", async () => {
		await withEnv(undefined, async () => {
			reset({ body: { results: [] } });
			await assert.rejects(() => searchWithTavily({ query: "q" }, {}), /TAVILY_API_KEY/);
			assert.equal(captures.length, 0);
		});
	});
});
