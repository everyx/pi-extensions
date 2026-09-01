/**
 * Tests for the search fuse walk (search/fuse.ts): failover order, all-fail
 * aggregation, hint capture, and the no-candidate case. Fake channels — the
 * walk is pure composition, so no HTTP, no keys, no CLI.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidatesFor, searchFuse } from "../search/fuse.js";
import type { SearchChannel, SearchResultItem, WebSearchParams } from "../types.js";

const bare: WebSearchParams = { query: "hello" };
const RESULT: SearchResultItem = { title: "t", url: "u", snippet: "" };

function fake(overrides: Partial<SearchChannel> & { id: SearchChannel["id"] }): SearchChannel {
	const base: SearchChannel = {
		id: overrides.id,
		available: () => true,
		supports: () => true,
		search: () => Promise.resolve([RESULT]),
	};
	return { ...base, ...overrides };
}

describe("search fuse walk", () => {
	it("fails over: the failing channel is captured, the next candidate wins", async () => {
		const attempts: string[] = [];
		const a = fake({
			id: "tinyfish",
			search: async () => {
				attempts.push("a");
				throw new Error("quota");
			},
		});
		const b = fake({
			id: "exa",
			search: async () => {
				attempts.push("b");
				return [RESULT];
			},
		});
		const out = await searchFuse(bare, [a, b], {});
		assert.deepEqual(attempts, ["a", "b"], "walked in order until the win");
		assert.equal(out.channel, "exa");
		assert.equal(out.results.length, 1);
		assert.deepEqual(out.failures, [{ channel: "tinyfish", error: "quota" }]);
	});

	it("all-fail: the last channel's raw error seeds the LLM text", async () => {
		const a = fake({ id: "tinyfish", search: async () => Promise.reject(new Error("e1")) });
		const b = fake({ id: "exa", search: async () => Promise.reject(new Error("e2")) });
		const out = await searchFuse(bare, [a, b], {});
		assert.equal(out.channel, undefined);
		assert.deepEqual(out.results, []);
		assert.equal(out.lastError, "e2");
		assert.deepEqual(
			out.failures.map((f) => f.channel),
			["tinyfish", "exa"],
		);
	});

	it("captures config hints from channel errors (UI-only guidance)", async () => {
		const err = new Error("no key") as Error & { hint: string };
		err.hint = "Set TINYFISH_API_KEY";
		const a = fake({ id: "tinyfish", search: async () => Promise.reject(err) });
		const out = await searchFuse(bare, [a], {});
		assert.deepEqual(out.failures, [{ channel: "tinyfish", error: "no key", hint: "Set TINYFISH_API_KEY" }]);
	});

	it("no candidates: nothing is attempted, failures stay empty", async () => {
		let attempted = false;
		const a = fake({
			id: "tinyfish",
			available: () => false,
			search: async () => {
				attempted = true;
				return [RESULT];
			},
		});
		const out = await searchFuse(bare, [a], {});
		assert.equal(out.channel, undefined);
		assert.deepEqual(out.failures, []);
		assert.equal(attempted, false);
	});

	it("capability gate: an available channel that cannot honor the filters is skipped", async () => {
		const a = fake({
			id: "exa",
			supports: (p) => !p.blocked_domains,
			search: () => Promise.resolve([RESULT]),
		});
		const out = await searchFuse({ query: "q", blocked_domains: ["r.com"] }, [a], {});
		assert.equal(out.channel, undefined, "skipped, not degraded");
		assert.deepEqual(out.failures, [], "a skip is not a failure");
	});

	it("onAttempt fires once per candidate, in fuse order", async () => {
		const seen: string[] = [];
		const a = fake({ id: "tinyfish", search: async () => Promise.reject(new Error("x")) });
		const b = fake({ id: "exa" });
		await searchFuse(bare, [a, b], { onAttempt: (id) => seen.push(id) });
		assert.deepEqual(seen, ["tinyfish", "exa"]);
	});

	it("the answering channel's echo rides the outcome (bsk engine)", async () => {
		const b = fake({ id: "bsk", echo: () => ({ engine: "baidu" as const }) });
		const out = await searchFuse({ query: "你好", locale: "zh-CN" }, [b], {});
		assert.equal(out.channel, "bsk");
		assert.equal(out.echo?.engine, "baidu");
	});
});

describe("candidatesFor", () => {
	it("keeps only available channels that support the request, in order", async () => {
		const cs = [
			fake({ id: "tinyfish", available: () => false }),
			fake({ id: "exa", supports: () => false }),
			fake({ id: "firecrawl" }),
		];
		assert.deepEqual(
			(await candidatesFor(bare, cs)).map((c) => c.id),
			["firecrawl"],
		);
	});
});
