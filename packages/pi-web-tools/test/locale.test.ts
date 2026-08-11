/**
 * Tests for engine priority + URL building (search/locale.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	countryFromLocale,
	enginePriorityForLocale,
	engineSearchUrl,
	normalizedLocale,
	primaryLanguage,
} from "../search/locale.js";

describe("primaryLanguage", () => {
	it("extracts the primary language subtag", () => {
		assert.equal(primaryLanguage("zh-CN"), "zh");
		assert.equal(primaryLanguage("zh_CN"), "zh");
		assert.equal(primaryLanguage("ja-JP"), "ja");
		assert.equal(primaryLanguage("en-US"), "en");
		assert.equal(primaryLanguage("en"), "en");
	});
	it("empty/undefined → empty", () => {
		assert.equal(primaryLanguage(), "");
		assert.equal(primaryLanguage("  "), "");
	});
});

describe("enginePriorityForLocale", () => {
	it("中文 → bing > baidu > google", () => {
		assert.deepEqual(enginePriorityForLocale("zh-CN"), ["bing", "baidu", "google"]);
	});
	it("俄语 → yandex > google > bing", () => {
		assert.deepEqual(enginePriorityForLocale("ru-RU"), ["yandex", "google", "bing"]);
	});
	it("其他 → google > bing", () => {
		assert.deepEqual(enginePriorityForLocale("ja-JP"), ["google", "bing"]);
		assert.deepEqual(enginePriorityForLocale("ko-KR"), ["google", "bing"]);
		assert.deepEqual(enginePriorityForLocale("en-US"), ["google", "bing"]);
	});
	it("no locale → default google > bing", () => {
		assert.deepEqual(enginePriorityForLocale(), ["google", "bing"]);
	});
});

describe("normalizedLocale", () => {
	it("normalizes BCP-47 casing (lang-lower, region-upper)", () => {
		assert.equal(normalizedLocale("zh-cn"), "zh-CN");
		assert.equal(normalizedLocale("zh-CN"), "zh-CN");
		assert.equal(normalizedLocale("ja-JP"), "ja-JP");
	});
	it("language-only stays lowercase", () => {
		assert.equal(normalizedLocale("EN"), "en");
	});
	it("missing → en-US", () => {
		assert.equal(normalizedLocale(), "en-US");
	});
});

describe("countryFromLocale", () => {
	it("extracts region subtag", () => {
		assert.equal(countryFromLocale("zh-CN"), "CN");
		assert.equal(countryFromLocale("ja-JP"), "JP");
	});
	it("language-only → empty", () => {
		assert.equal(countryFromLocale("en"), "");
	});
});

describe("engineSearchUrl", () => {
	it("google builds gl/hl/lr from locale + tbs from recency", () => {
		const { url, localeParams } = engineSearchUrl("google", "zh-CN", "qdr:w");
		assert.equal(url, "https://www.google.com/search?q={q}");
		assert.deepEqual(localeParams, { gl: "CN", hl: "zh-CN", lr: "lang_zh", tbs: "qdr:w" });
	});
	it("bing eats BCP-47 directly via mkt; zh-CN serves from cn.bing.com", () => {
		const { url, localeParams } = engineSearchUrl("bing", "zh-CN");
		assert.equal(url, "https://cn.bing.com/search?q={q}");
		assert.deepEqual(localeParams, { mkt: "zh-CN" });
		// zh-TW is NOT the mainland data source → international bing.com.
		const tw = engineSearchUrl("bing", "zh-TW");
		assert.equal(tw.url, "https://www.bing.com/search?q={q}");
	});
	it("baidu is natively Chinese, no locale params", () => {
		const { url, localeParams } = engineSearchUrl("baidu", "zh-CN");
		assert.equal(url, "https://www.baidu.com/s?wd={q}");
		assert.equal(localeParams, undefined);
	});
	it("yandex sets lr=213 for Russian and serves from yandex.ru", () => {
		const { url, localeParams } = engineSearchUrl("yandex", "ru-RU");
		assert.equal(url, "https://yandex.ru/search/?text={q}");
		assert.deepEqual(localeParams, { lr: "213" });
		const intl = engineSearchUrl("yandex", "en-US");
		assert.equal(intl.url, "https://yandex.com/search/?text={q}");
	});
	it("no locale → no locale params", () => {
		const { localeParams } = engineSearchUrl("google");
		assert.deepEqual(localeParams, {});
	});
});
