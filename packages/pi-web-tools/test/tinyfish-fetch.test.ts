/**
 * Tests for TinyFish Fetch (fetch/api/tinyfish-fetch.ts): POST shape, auth,
 * per-URL result matching, and failure → null (fuse semantics). HTTP is
 * stubbed at the global fetch boundary.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithTinyfish } from "../fetch/api/tinyfish-fetch.js";

function withKey(fn: () => Promise<void>): Promise<void> {
	process.env.TINYFISH_API_KEY = "test-key";
	return fn().finally(() => delete process.env.TINYFISH_API_KEY);
}

function stubFetch(
	body: unknown,
	capture: { url?: string; headers?: Record<string, string>; body?: string } = {},
): void {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		capture.url = String(input);
		capture.headers = (init?.headers ?? {}) as Record<string, string>;
		capture.body = String(init?.body ?? "");
		return new Response(JSON.stringify(body), { status: 200 });
	}) as typeof fetch;
}

describe("tinyfish fetch adapter", () => {
	it("POSTs the URL with markdown format, keyless by default", async () => {
		const capture: { url?: string; headers?: Record<string, string>; body?: string } = {};
		stubFetch({ results: [{ url: "https://a.dev", title: "T", text: "# Hello" }] }, capture);

		const text = await fetchWithTinyfish("https://a.dev");
		assert.ok(capture.url, "fetch was called");
		assert.equal(capture.url, "https://api.fetch.tinyfish.ai");
		assert.match(capture.headers?.["Content-Type"] ?? "", /application\/json/);
		assert.equal(capture.headers?.["X-API-Key"], undefined, "keyless first");
		const body = JSON.parse(capture.body ?? "{}");
		assert.deepEqual(body, { urls: ["https://a.dev"], format: "markdown" });
		assert.equal(text, "# Hello");
	});

	it("sends X-API-Key when set (shared with the search channel)", async () => {
		await withKey(async () => {
			const capture: { headers?: Record<string, string> } = {};
			stubFetch({ results: [{ url: "https://a.dev", text: "ok" }] }, capture);
			await fetchWithTinyfish("https://a.dev");
			assert.equal(capture.headers?.["X-API-Key"], "test-key");
		});
	});

	it("matches the result by URL, not by position", async () => {
		stubFetch({
			results: [
				{ url: "https://else.dev", text: "wrong" },
				{ url: "https://a.dev", text: "right" },
			],
		});
		assert.equal(await fetchWithTinyfish("https://a.dev"), "right");
	});

	it("returns null when the URL is missing from results (per-URL error)", async () => {
		stubFetch({ results: [], errors: [{ url: "https://a.dev", error: "blocked" }] });
		assert.equal(await fetchWithTinyfish("https://a.dev"), null);
	});

	it("returns null on HTTP error and on network failure (fuse advance)", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
		assert.equal(await fetchWithTinyfish("https://a.dev"), null);
		globalThis.fetch = (async () => {
			throw new Error("ECONNRESET");
		}) as typeof fetch;
		assert.equal(await fetchWithTinyfish("https://a.dev"), null);
	});
});
