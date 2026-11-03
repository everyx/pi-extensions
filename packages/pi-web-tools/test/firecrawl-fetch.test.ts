/**
 * Tests for the Firecrawl fetch adapter (fetch/api/firecrawl-fetch.ts) and the
 * renderer gate in front of the fuse.
 *
 * The adapter carries weight beyond its own behaviour: after TinyFish started
 * requiring a key (401 without one), this is the only renderer that still
 * answers a keyless install. If it silently stops working, web_fetch loses its
 * fallback entirely — which is exactly what went unnoticed before.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithFirecrawl } from "../fetch/api/firecrawl-fetch.js";
import { renderMayHelp } from "../fetch/fetch.js";

function withoutKey(fn: () => Promise<void>): Promise<void> {
	const prev = process.env.FIRECRAWL_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
	return fn().finally(() => {
		if (prev) process.env.FIRECRAWL_API_KEY = prev;
	});
}

function withKey(fn: () => Promise<void>): Promise<void> {
	const prev = process.env.FIRECRAWL_API_KEY;
	process.env.FIRECRAWL_API_KEY = "test-key";
	return fn().finally(() => {
		if (prev) process.env.FIRECRAWL_API_KEY = prev;
		else delete process.env.FIRECRAWL_API_KEY;
	});
}

interface Capture {
	url?: string;
	headers?: Record<string, string>;
	body?: string;
}

function stubFetch(body: unknown, status = 200, capture: Capture = {}): void {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		capture.url = String(input);
		capture.headers = (init?.headers ?? {}) as Record<string, string>;
		capture.body = String(init?.body ?? "");
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("firecrawl fetch adapter", () => {
	it("POSTs the url with markdown format, and sends no auth when keyless", () =>
		withoutKey(async () => {
			const capture: Capture = {};
			stubFetch({ success: true, data: { markdown: "# Title\n\nbody" } }, 200, capture);

			const rendered = await fetchWithFirecrawl("https://a.dev/page", Date.now() + 5_000);

			assert.equal(capture.url, "https://api.firecrawl.dev/v2/scrape");
			assert.equal(capture.headers?.Authorization, undefined);
			const sent = JSON.parse(String(capture.body)) as { url?: string; formats?: string[] };
			assert.equal(sent.url, "https://a.dev/page");
			assert.deepEqual(sent.formats, ["markdown"], "only markdown: HTML would be re-extracted");
			assert.deepEqual(rendered.content, { text: "# Title\n\nbody", contentType: "text/markdown" });
		}));

	it("keeps the key in reserve while the free tier is answering", () =>
		withKey(async () => {
			// Same policy as the search channel: the keyed pool is shared with
			// pi-read-doc's OCR credits, so it is spent only when keyless refuses.
			const capture: Capture = {};
			stubFetch({ success: true, data: { markdown: "ok" } }, 200, capture);
			await fetchWithFirecrawl("https://a.dev", Date.now() + 5_000);
			assert.equal(capture.headers?.Authorization, undefined, "a key on disk must not be spent by default");
		}));

	it("escalates to the keyed pool when the keyless quota answers 429", () =>
		withKey(async () => {
			const seen: (string | undefined)[] = [];
			globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				seen.push(headers.Authorization);
				const status = seen.length === 1 ? 429 : 200;
				return new Response(JSON.stringify({ success: true, data: { markdown: "fine" } }), { status });
			}) as typeof fetch;

			const rendered = await fetchWithFirecrawl("https://a.dev", Date.now() + 5_000);
			assert.deepEqual(seen, [undefined, "Bearer test-key"], "keyless first, then keyed");
			assert.equal(rendered.content?.text, "fine");
		}));

	it("returns null instead of throwing when the renderer cannot deliver", () =>
		withoutKey(async () => {
			// 429 with no key to escalate to: quota is a fuse advance, not an error.
			stubFetch({ success: false, error: "rate limited" }, 429);
			assert.equal((await fetchWithFirecrawl("https://a.dev", Date.now() + 5_000)).content, null);

			stubFetch({ success: true, data: { markdown: "   " } }, 200);
			const empty = await fetchWithFirecrawl("https://a.dev", Date.now() + 5_000);
			assert.equal(empty.content, null, "empty markdown is a failure");
			assert.equal(empty.reason, "empty markdown", "the card learns why, not just that");

			globalThis.fetch = (async () => {
				throw new Error("ECONNRESET");
			}) as typeof fetch;
			assert.equal((await fetchWithFirecrawl("https://a.dev", Date.now() + 5_000)).content, null);
		}));
});

describe("renderMayHelp — when spending the fuse is worth it", () => {
	it("fires for the failures a renderer can actually fix", () => {
		// 403 = anti-bot wall; 0 = no status at all (network failure); 5xx = transient.
		for (const status of [0, 403, 500, 502, 503]) {
			assert.equal(renderMayHelp(status), true, `status ${status}`);
		}
	});

	it("stays out of the way when rendering cannot change the answer", () => {
		for (const status of [401, 402, 404, 407, 410, 429, 451]) {
			assert.equal(renderMayHelp(status), false, `status ${status}`);
		}
	});
});

describe("firecrawl fetch adapter — the fuse budget covers queueing", () => {
	it("does not spend a request whose deadline already passed", () =>
		withoutKey(async () => {
			let called = false;
			globalThis.fetch = (async () => {
				called = true;
				return new Response("{}", { status: 200 });
			}) as typeof fetch;

			// The limiter serializes calls; a queued task must re-check the clock
			// when it finally gets a slot, or the 45 s fuse silently stretches.
			const rendered = await fetchWithFirecrawl("https://a.dev", Date.now() - 1);
			assert.equal(rendered.content, null);
			assert.equal(called, false, "no request is made past the deadline");
		}));

	it("does not start when the caller already cancelled", () =>
		withoutKey(async () => {
			let called = false;
			globalThis.fetch = (async () => {
				called = true;
				return new Response("{}", { status: 200 });
			}) as typeof fetch;

			const controller = new AbortController();
			controller.abort();
			const rendered = await fetchWithFirecrawl("https://a.dev", Date.now() + 5_000, controller.signal);
			assert.equal(rendered.content, null);
			assert.equal(called, false, "a cancelled call never reaches the network");
		}));
});
