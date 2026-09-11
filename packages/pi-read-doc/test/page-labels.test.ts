/**
 * Tests for page labels (page-labels.ts): page numbers as text, for the model
 * payload and for the human-readable card.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPages } from "../page-labels.js";

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
