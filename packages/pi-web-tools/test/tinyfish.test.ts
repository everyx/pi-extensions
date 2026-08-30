/**
 * Tests for the TinyFish adapter (search/api/tinyfish.ts): param mapping and
 * auth. HTTP is stubbed at the global fetch boundary.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchWithTinyfish } from "../search/api/tinyfish.js";
import type { WebSearchParams } from "../types.js";

function withKey(fn: () => Promise<void>): Promise<void> {
	process.env.TINYFISH_API_KEY = "test-key";
	return fn().finally(() => delete process.env.TINYFISH_API_KEY);
}

function stubFetch(body: unknown, capture: { url?: string; headers?: Record<string, string> } = {}): void {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		capture.url = String(input);
		capture.headers = (init?.headers ?? {}) as Record<string, string>;
		return new Response(JSON.stringify(body), { status: 200 });
	}) as typeof fetch;
}

describe("tinyfish adapter", () => {
	it("maps locale/recency/domains onto the query string", async () => {
		await withKey(async () => {
			const capture: { url?: string; headers?: Record<string, string> } = {};
			stubFetch({ results: [{ title: "T", url: "https://a.dev", snippet: "s" }] }, capture);

			const params: WebSearchParams = {
				query: "rust cli",
				locale: "zh-CN",
				recency: "week",
				allowed_domains: ["github.com", "crates.io"],
				blocked_domains: ["reddit.com"],
			};
			const results = await searchWithTinyfish(params, {});
			assert.ok(capture.url, "fetch was called");
			const url = new URL(capture.url);
			assert.equal(url.searchParams.get("query"), "rust cli");
			assert.equal(url.searchParams.get("language"), "zh");
			assert.equal(url.searchParams.get("location"), "CN");
			assert.equal(url.searchParams.get("recency_minutes"), "10080");
			assert.equal(url.searchParams.get("include_domains"), "github.com,crates.io");
			assert.equal(url.searchParams.get("exclude_domains"), "reddit.com");
			assert.equal(capture.headers?.["X-API-Key"], "test-key");
			assert.equal(results.length, 1);
			assert.equal(results[0]?.url, "https://a.dev");
		});
	});

	it("omits locale params entirely when none is passed (pure executor)", async () => {
		await withKey(async () => {
			const capture: { url?: string } = {};
			stubFetch({ results: [] }, capture);
			await searchWithTinyfish({ query: "hello" }, {});
			assert.ok(capture.url, "fetch was called");
			const url = new URL(capture.url);
			assert.equal(url.searchParams.get("language"), null);
			assert.equal(url.searchParams.get("location"), null);
			assert.equal(url.searchParams.get("recency_minutes"), null);
		});
	});

	it("throws without a key", async () => {
		delete process.env.TINYFISH_API_KEY;
		await assert.rejects(() => searchWithTinyfish({ query: "q" }, {}), /TINYFISH_API_KEY/);
	});
});
