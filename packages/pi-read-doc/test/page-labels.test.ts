/**
 * Tests for page labels (page-labels.ts): page numbers as text, for the model
 * payload and for the human-readable card.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPages, hostedNote } from "../page-labels.js";

describe("formatPages — 紧凑页号", () => {
	it("单页、连续段、离散页", () => {
		assert.equal(formatPages([3]), "3");
		assert.equal(formatPages([1, 2]), "1-2");
		assert.equal(formatPages([3, 7]), "3, 7");
		assert.equal(formatPages([21, 22, 23, 24]), "21-24");
		assert.equal(formatPages([1, 2, 5, 9, 10, 11]), "1-2, 5, 9-11");
	});

	it("乱序与重复都归位（幂等）", () => {
		assert.equal(formatPages([5, 3, 4, 3]), "3-5");
	});

	it("空 → 空串", () => {
		assert.equal(formatPages([]), "");
	});
});

describe("hostedNote", () => {
	it("点名被 OCR 的页（hosted 返回整份 blob，切不开，但哪几页我们知道）", () => {
		assert.equal(hostedNote([3, 7], 400), "pages 3, 7 were read by OCR — may misread");
	});

	it("整份都要 OCR 时说 every page", () => {
		assert.equal(hostedNote([1, 2, 3], 3), "every page was read by OCR — may misread");
	});

	it("散页太多时给数量而不是一长串页号", () => {
		const scattered = [1, 3, 5, 7, 9, 11, 13, 15, 17];
		assert.equal(hostedNote(scattered, 100), "9 pages were read by OCR — may misread");
	});
});
