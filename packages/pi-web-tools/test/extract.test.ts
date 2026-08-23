import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXTRACT_SCRIPT, isCaptchaState, parseExtraction, parsePageState } from "../search/extract.js";

describe("parseExtraction", () => {
	it("keeps entries with both url and title, drops the rest", () => {
		const raw = JSON.stringify([
			{ title: "t", url: "https://a", snippet: "s" },
			{ title: "", url: "https://b" },
			{ title: "no-url" },
		]);
		assert.deepEqual(parseExtraction(raw), [{ title: "t", url: "https://a", snippet: "s" }]);
	});

	it("throws a channel-scoped error on malformed payloads", () => {
		assert.throws(() => parseExtraction("<html>"), /could not parse search results/);
	});
});

describe("isCaptchaState", () => {
	it("flags anti-bot walls by url or body text", () => {
		assert.equal(isCaptchaState({ url: "https://g/?captcha=1", text: "" }), true);
		assert.equal(isCaptchaState({ url: "https://g/", text: "please confirm you are not a robot" }), true);
		assert.equal(isCaptchaState({ url: "https://g/", text: "Automated requests detected" }), true);
	});

	it("passes clean empty states", () => {
		assert.equal(isCaptchaState({ url: "https://g/search?q=x", text: "" }), false);
		assert.equal(isCaptchaState({ url: "", text: "" }), false);
	});
});

describe("parsePageState", () => {
	it("tolerates malformed probe payloads", () => {
		assert.deepEqual(parsePageState("not json"), { url: "", text: "" });
		assert.deepEqual(parsePageState('{"url":"https://a","text":"t"}'), { url: "https://a", text: "t" });
	});
});

describe("EXTRACT_SCRIPT", () => {
	it("stays a self-executing JSON-producing snippet covering redirect decoding", () => {
		assert.ok(EXTRACT_SCRIPT.includes("querySelectorAll('h3, h2')"));
		assert.ok(EXTRACT_SCRIPT.includes("bing\\.com\\/ck\\/"), "bing redirect decoding present");
		assert.ok(EXTRACT_SCRIPT.includes("JSON.stringify(out)"));
	});
});
