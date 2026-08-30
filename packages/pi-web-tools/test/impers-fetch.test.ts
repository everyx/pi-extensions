/**
 * Tests for the impers adapter (fetch/api/impers-fetch.ts): option mapping
 * and the forced-degraded gate. The native lib (libcurl-impersonate) is
 * deliberately NOT exercised here — pipeline tests run with
 * PI_WEB_TOOLS_NO_IMPERS=1 (hermetic), and live fingerprint behavior was
 * validated in the design PoC (tls.browserleaks.com ja4 == real Chrome).
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildImpersOptions, impersFetchRaw, impersForcedOff } from "../fetch/api/impers-fetch.js";

describe("buildImpersOptions", () => {
	it("impersonates chrome with the two deliberate overrides only", () => {
		const o = buildImpersOptions("text/markdown, text/html, */*;q=0.8", 30_000);
		assert.equal(o.impersonate, "chrome");
		assert.equal(o.stream, true);
		assert.equal(o.maxRedirects, 10);
		// seconds, rounded up — a 30s budget never truncates to 29
		assert.equal(o.timeout, 30);
		const h = o.headers as Record<string, string>;
		assert.equal(h.Accept, "text/markdown, text/html, */*;q=0.8");
		assert.equal(h["Cache-Control"], "no-cache");
	});

	it("raw mode passes the HTML accept back unchanged", () => {
		const o = buildImpersOptions("text/html, */*;q=0.8", 1_500);
		assert.equal((o.headers as Record<string, string>).Accept, "text/html, */*;q=0.8");
		assert.equal(o.timeout, 2, "rounds 1.5s up to 2");
	});
});

describe("degraded gate", () => {
	const KEY = "PI_WEB_TOOLS_NO_IMPERS";
	afterEach(() => delete process.env[KEY]);

	it("PI_WEB_TOOLS_NO_IMPERS=1 forces the degraded tier", async () => {
		process.env[KEY] = "1";
		assert.equal(impersForcedOff(), true);
		// Never touches the native lib — returns null without loading it.
		assert.equal(
			await impersFetchRaw("https://example.com", { timeoutMs: 1000, accept: "text/html", maxBytes: 1024 }),
			null,
		);
	});

	it("unset means impers is not forced off (gate only)", () => {
		assert.equal(impersForcedOff(), false);
	});
});
