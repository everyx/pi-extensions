/**
 * Tests for the document conversion chain (convert.ts): fallback order,
 * the quota gate, and charge-on-success. Fake deps — no anydoc engine, no
 * network, no rapid CLI.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ConvertDeps, convertDocument, QUOTA_LIMIT, type QuotaStore } from "../convert.js";

function needsOcrError(pages?: unknown[]): Error & { code: string; pages?: unknown[] } {
	const e = new Error("scanned pages need OCR") as Error & { code: string; pages?: unknown[] };
	e.code = "needsOcr";
	if (pages) e.pages = pages;
	return e;
}

interface DepsHarness extends ConvertDeps {
	mdCalls: number;
	hostedCalls: number;
	rapidCalls: string[];
	charged: number[];
	limitWrapped: number;
}

function harness(overrides: Partial<ConvertDeps> & { mdResult?: string | (() => Promise<string>) } = {}): DepsHarness {
	const h: DepsHarness = {
		mdCalls: 0,
		hostedCalls: 0,
		rapidCalls: [],
		charged: [],
		limitWrapped: 0,
		toMarkdown: async (_path, opts) => {
			h.mdCalls++;
			if (opts?.ocr === "hosted") h.hostedCalls++;
			const r = overrides.mdResult;
			if (typeof r === "function") return r();
			if (typeof r === "string") return r;
			throw needsOcrError([{}, {}]);
		},
		quota: {
			async used() {
				return overrides.quota ? await overrides.quota.used() : 0;
			},
			async charge(pages) {
				h.charged.push(pages);
				await overrides.quota?.charge(pages);
			},
		} satisfies QuotaStore,
		limit: async (fn) => {
			h.limitWrapped++;
			return fn();
		},
		rapidOcr: async (path) => {
			h.rapidCalls.push(path);
			return overrides.rapidOcr ? overrides.rapidOcr(path) : null;
		},
	};
	return h;
}

describe("convertDocument — chain", () => {
	it("anydoc local success — no fallback, no charge", async () => {
		const h = harness({ mdResult: "# doc" });
		const doc = await convertDocument("a.docx", ".docx", h);
		assert.equal(doc.via, "anydoc");
		assert.equal(doc.text, "# doc");
		assert.equal(h.mdCalls, 1);
		assert.equal(h.hostedCalls, 0);
		assert.deepEqual(h.charged, []);
	});

	it("needsOcr → hosted (quota open): succeeds, rate-limited, charged per page", async () => {
		const h = harness({ mdResult: () => Promise.reject(needsOcrError([{}, {}, {}])) });
		// hosted succeeds: the second toMarkdown call (with ocr option) wins
		h.toMarkdown = async (_path, opts) => {
			h.mdCalls++;
			if (opts?.ocr === "hosted") {
				h.hostedCalls++;
				return "ocr'd";
			}
			throw needsOcrError([{}, {}, {}]);
		};
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(doc.via, "anydoc:hosted");
		assert.equal(doc.text, "ocr'd");
		assert.equal(h.hostedCalls, 1);
		assert.equal(h.limitWrapped, 1, "hosted call goes through the rate limit");
		assert.deepEqual(h.charged, [3], "charged by the reported page count");
	});

	it("hosted failure → rapidocr (pdf only) → rapid", async () => {
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([{}])),
			rapidOcr: async () => "rapid text",
		});
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(doc.via, "rapid");
		assert.equal(doc.text, "rapid text");
		assert.equal(h.hostedCalls, 1, "hosted was tried first");
		assert.deepEqual(h.charged, [], "no charge when hosted failed");
	});

	it("quota exhausted → hosted skipped, rapidocr still serves pdfs", async () => {
		const h = harness({
			quota: {
				async used() {
					return QUOTA_LIMIT;
				},
				async charge() {},
			},
			rapidOcr: async () => "rapid text",
		});
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(doc.via, "rapid");
		assert.equal(h.hostedCalls, 0, "quota gate skips hosted");
	});

	it("quota exhausted + non-pdf → the original needsOcr error propagates", async () => {
		const h = harness({
			quota: {
				async used() {
					return QUOTA_LIMIT;
				},
				async charge() {},
			},
		});
		await assert.rejects(
			() => convertDocument("a.docx", ".docx", h),
			(err: Error & { code?: string }) => err.code === "needsOcr",
		);
		assert.equal(h.hostedCalls, 0);
		assert.deepEqual(h.rapidCalls, [], "rapid is pdf-only");
	});

	it("rapidocr unavailable (null) → the needsOcr error propagates", async () => {
		const h = harness({});
		await assert.rejects(
			() => convertDocument("a.pdf", ".pdf", h),
			(err: Error & { code?: string }) => err.code === "needsOcr",
		);
		assert.deepEqual(h.rapidCalls, ["a.pdf"]);
	});

	it("non-needsOcr engine errors propagate untouched (no fallback)", async () => {
		const h = harness({
			mdResult: () => Promise.reject(new Error("corrupt file")),
			rapidOcr: async () => "rapid text",
		});
		await assert.rejects(() => convertDocument("a.pdf", ".pdf", h), /corrupt file/);
		assert.equal(h.hostedCalls, 0);
		assert.deepEqual(h.rapidCalls, []);
	});

	it("an empty page list still charges one page (the floor)", async () => {
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([])),
		});
		h.toMarkdown = async (_path, opts) => {
			if (opts?.ocr === "hosted") return "ocr'd";
			throw needsOcrError([]);
		};
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(doc.via, "anydoc:hosted");
		assert.deepEqual(h.charged, [1], "0 pages is impossible — charge the floor");
	});
});
