import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planPages } from "../pdf/plan.js";

/** Page numbers 1..n — the "whole document" shorthand. */
const pages = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("planPages — 页面路由决策表", () => {
	it("整份都是文字层（anydoc 未标记）→ 一段，零 OCR", () => {
		const p = planPages({ pageCount: 5, flagged: [], withTextLayer: [] });
		assert.deepEqual(p.textRuns, [pages(5)]);
		assert.deepEqual(p.ocrPages, []);
	});

	it("整份都是扫描页 → 无文字段，全部 OCR", () => {
		const p = planPages({ pageCount: 3, flagged: [1, 2, 3], withTextLayer: [] });
		assert.deepEqual(p.textRuns, []);
		assert.deepEqual(p.ocrPages, [1, 2, 3]);
	});

	it("混合档：文字段在 OCR 页两侧断开，按页序", () => {
		const p = planPages({ pageCount: 6, flagged: [3, 5], withTextLayer: [] });
		assert.deepEqual(p.textRuns, [[1, 2], [4], [6]]);
		assert.deepEqual(p.ocrPages, [3, 5]);
	});

	it("误判页（anydoc 标记但文字层读得出）回到文字段，并把两侧接起来", () => {
		const p = planPages({ pageCount: 5, flagged: [2, 4], withTextLayer: [2] });
		// 页 2 是误判 → 只有页 4 真需要 OCR → 文字段合并成 1-3 与 5
		assert.deepEqual(p.textRuns, [[1, 2, 3], [5]]);
		assert.deepEqual(p.ocrPages, [4]);
	});

	it("全部标记都是误判 → 退化成整份文字层", () => {
		const p = planPages({ pageCount: 3, flagged: [1, 2, 3], withTextLayer: [1, 2, 3] });
		assert.deepEqual(p.textRuns, [pages(3)]);
		assert.deepEqual(p.ocrPages, []);
	});

	it("标记乱序也稳定（按页序输出）", () => {
		const p = planPages({ pageCount: 4, flagged: [4, 1, 3], withTextLayer: [] });
		assert.deepEqual(p.ocrPages, [1, 3, 4]);
		assert.deepEqual(p.textRuns, [[2]]);
	});
});
