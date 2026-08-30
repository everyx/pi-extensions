/**
 * Real-browser tests (bsk channel, opt-in).
 *
 * These launch/connect the user's actual Chromium — a window pops and bsk's
 * daemon starts, so they do NOT run by default. Enable explicitly with
 * PI_WEB_TOOLS_TEST_BSK=1. The default test script force-sets
 * PI_WEB_TOOLS_NO_BSK=1; this file clears it at load so the channel works
 * when opted in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchUrlWithBsk, searchWithBsk } from "../search/browser.js";
import type { WebSearchParams } from "../types.js";

const enabled = process.env.PI_WEB_TOOLS_TEST_BSK === "1";
const itBsk = enabled ? it : it.skip;

// Opt-in tests override the hermetic-test gate.
if (enabled) delete process.env.PI_WEB_TOOLS_NO_BSK;

describe("bsk real-browser channel (opt-in: PI_WEB_TOOLS_TEST_BSK=1)", () => {
	itBsk("fetchUrlWithBsk returns rendered page text", async () => {
		// First call opens the session; retry once to cover slow browsers.
		const text = (await fetchUrlWithBsk("https://example.com/")) ?? (await fetchUrlWithBsk("https://example.com/"));
		assert.ok(text, "page text returned");
		if (text === null) return;
		assert.match(text, /Example Domain/);
	});

	itBsk("searchWithBsk returns result items", async () => {
		const params: WebSearchParams = { query: "example" };
		const results = await searchWithBsk(params, { timeoutMs: 30_000 });
		assert.ok(Array.isArray(results));
		assert.ok(results.length > 0, "got search results");
		for (const r of results) {
			assert.ok(r.url && r.title, "result carries url + title");
		}
	});
});
