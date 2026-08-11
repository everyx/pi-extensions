/**
 * Tests for system locale detection (search/system-locale.ts) — pure
 * parsing; the execFileSync wiring is a thin shell (like isBskAvailable).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localeFromLocalectl } from "../search/system-locale.js";

describe("localeFromLocalectl", () => {
	it("parses the System Locale line with quotes", () => {
		const out = `System Locale: LANG="zh_CN.UTF-8"
       VC Keymap: us
      X11 Layout: us`;
		assert.equal(localeFromLocalectl(out), "zh_CN.UTF-8");
	});
	it("parses without quotes", () => {
		assert.equal(localeFromLocalectl("System Locale: LANG=en_US.UTF-8"), "en_US.UTF-8");
	});
	it("returns undefined when the locale is n/a or LANG is absent", () => {
		assert.equal(localeFromLocalectl("System Locale: n/a"), undefined);
		assert.equal(localeFromLocalectl("System Locale: LANG=\n"), undefined);
		assert.equal(localeFromLocalectl(""), undefined);
	});
	it("ignores LC_* lines that are not LANG", () => {
		const out = `System Locale: LC_CTYPE=zh_CN.UTF-8
                     LANG=ru_RU.UTF-8`;
		assert.equal(localeFromLocalectl(out), "ru_RU.UTF-8");
	});
});
