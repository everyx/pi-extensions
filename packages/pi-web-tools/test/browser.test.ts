/**
 * Real-browser tests (bsk channel, opt-in).
 *
 * These launch the user's actual Chromium — a window pops and bsk's daemon
 * starts — so they do NOT run by default. Enable explicitly with
 * PI_WEB_TOOLS_TEST_BSK=1. Tests are hermetic by rule (no real sites), so
 * the browser pages here are served by a LOCAL http server; the default
 * test script force-sets PI_WEB_TOOLS_NO_BSK=1, and this file clears it at
 * load so the channel works when opted in. Real search-engine coverage
 * stays manual (a query against a live engine cannot be hermetic).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchUrlWithBsk } from "../search/browser.js";

const enabled = process.env.PI_WEB_TOOLS_TEST_BSK === "1";
const itBsk = enabled ? it : it.skip;

// Opt-in tests override the hermetic-test gate.
if (enabled) delete process.env.PI_WEB_TOOLS_NO_BSK;

const listener = createServer((req, res) => {
	if (req.url === "/") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><head><title>Local</title></head><body><h1>Local Browser Page</h1></body></html>");
		return;
	}
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("second page marker");
});

let base = "";
before(async () => {
	if (!enabled) return;
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
after(() => {
	if (!enabled) return;
	return new Promise<void>((resolve) => listener.close(() => resolve()));
});

describe("bsk real-browser channel (opt-in: PI_WEB_TOOLS_TEST_BSK=1, localhost only)", () => {
	itBsk("fetchUrlWithBsk renders a local page", async () => {
		// First call opens the session; retry once to cover slow browsers.
		const text = (await fetchUrlWithBsk(`${base}/`)) ?? (await fetchUrlWithBsk(`${base}/`));
		assert.ok(text, "page text returned");
		if (text === null) return;
		assert.match(text, /Local Browser Page/);
	});

	itBsk("a second fetch reuses the live session", async () => {
		const text = await fetchUrlWithBsk(`${base}/other`);
		assert.ok(text, "page text returned");
		if (text === null) return;
		assert.match(text, /second page marker/);
	});
});
