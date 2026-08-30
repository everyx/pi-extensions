/**
 * Tests for BCP-47 parsing (search/bcp47.ts) — the locale → channel-param
 * mapping primitives.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countryFromLocale, parseLocale, primaryLanguage } from "../search/bcp47.js";

describe("bcp47", () => {
	it("primaryLanguage extracts the language subtag", () => {
		assert.equal(primaryLanguage("zh-CN"), "zh");
		assert.equal(primaryLanguage("en_US"), "en");
		assert.equal(primaryLanguage("ja"), "ja");
		assert.equal(primaryLanguage(undefined), "");
	});

	it("countryFromLocale extracts the region subtag", () => {
		assert.equal(countryFromLocale("zh-CN"), "CN");
		assert.equal(countryFromLocale("en_US"), "US");
		assert.equal(countryFromLocale("ja"), "");
	});

	it("parseLocale falls back to the language's common market", () => {
		assert.deepEqual(parseLocale("zh-CN"), { language: "zh", country: "CN" });
		assert.deepEqual(parseLocale("ja"), { language: "ja", country: "JP" });
		assert.deepEqual(parseLocale("de-AT"), { language: "de", country: "AT" });
		assert.deepEqual(parseLocale(undefined), { language: "", country: "" });
	});
});
