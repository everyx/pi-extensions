/**
 * Tests for UA resolution (fetch/ua.ts): default-browser detection mapping
 * and standard UA string construction.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserIdFromName, buildUserAgent } from "../fetch/ua.js";

describe("browserIdFromName", () => {
	it("maps .desktop ids to families", () => {
		assert.equal(browserIdFromName("firefox.desktop"), "firefox");
		assert.equal(browserIdFromName("chromium.desktop"), "chromium");
		assert.equal(browserIdFromName("google-chrome.desktop"), "chrome");
		assert.equal(browserIdFromName("microsoft-edge.desktop"), "edge");
	});
	it("unknown for anything else", () => {
		assert.equal(browserIdFromName("foo.desktop"), "unknown");
		assert.equal(browserIdFromName(""), "unknown");
	});
});

describe("buildUserAgent", () => {
	it("firefox: standard format with rv matching the version", () => {
		const ua = buildUserAgent("firefox", "Mozilla Firefox 153.0.3", "linux");
		assert.equal(ua, "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0");
	});
	it("chromium: Chrome stable form (major.0.0.0), no headless marker", () => {
		const ua = buildUserAgent("chromium", "Chromium 151.0.7922.108", "linux");
		assert.equal(
			ua,
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		);
		assert.ok(!ua.includes("Headless"));
	});
	it("chrome: same family as chromium", () => {
		const ua = buildUserAgent("chrome", "Google Chrome 122.0.6261.94", "linux");
		assert.equal(
			ua,
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
		);
	});
	it("edge: chrome UA plus Edg/ version", () => {
		const ua = buildUserAgent("edge", "Microsoft Edge 100.0.1185.39", "linux");
		assert.equal(
			ua,
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36 Edg/100.0.1185.39",
		);
	});
	it("platform templates: macOS and Windows", () => {
		const ffMac = buildUserAgent("firefox", "Mozilla Firefox 153.0.3", "darwin");
		assert.equal(ffMac, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0");
		const crWin = buildUserAgent("chrome", "Google Chrome 122.0.6261.94", "win32");
		assert.equal(
			crWin,
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
		);
	});
});
