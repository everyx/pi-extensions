/**
 * Tests for the walk (convert.ts): which engine serves a document that needs
 * OCR, in what order, and what the caller hears when none can.
 *
 * Fake engines only — no parser, no network, no poppler, no OCR. The engines
 * have their own tests (firecrawl-engine, rapidocr-engine); the registry has
 * another.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertDocument, joinHints, type WalkDeps } from "../convert.js";
import { fakeEngine, needsOcrError } from "./helpers.js";

const MARKDOWN = async () => "# doc";
const NEEDS_OCR = async () => {
	throw needsOcrError([1, 3], 4);
};

const walk = (engines: WalkDeps["engines"], opts: Parameters<typeof convertDocument>[3] = {}) =>
	convertDocument("a.pdf", ".pdf", { parse: NEEDS_OCR, engines }, opts);

describe("convertDocument — the walk", () => {
	it("解析成功 → markdown，一个引擎都不问", async () => {
		const engine = fakeEngine("rapidocr", { ok: true, blocks: [] });
		const doc = await convertDocument("a.docx", ".docx", { parse: MARKDOWN, engines: [engine] });
		assert.equal(doc.kind, "markdown");
		assert.equal(doc.via, "anydoc");
		assert.equal(engine.calls, 0);
	});

	it("needsOcr → 第一个能服务的引擎胜出，via 就是它", async () => {
		const first = fakeEngine("firecrawl", { ok: false, hint: "paused" });
		const second = fakeEngine("rapidocr", { ok: true, blocks: [{ pages: [1], text: "x" }], hint: "read by rapidocr" });
		const doc = await walk([first, second]);
		assert.equal(doc.kind, "blocks");
		assert.equal(doc.via, "rapidocr");
		assert.equal(first.calls, 1);
		assert.equal(second.calls, 1);
	});

	it("先失败的引擎那句话即使后面成功也要带上去", async () => {
		const first = fakeEngine("firecrawl", { ok: false, hint: "the API key was rejected" });
		const second = fakeEngine("rapidocr", { ok: true, blocks: [], hint: "read by rapidocr" });
		const doc = await walk([first, second]);
		assert.match(doc.hint ?? "", /rejected/);
		assert.match(doc.hint ?? "", /rapidocr/);
	});

	it("顺序即策略：第一个成功就不问第二个（本地成功不该上传）", async () => {
		const first = fakeEngine("rapidocr", { ok: true, blocks: [] });
		const second = fakeEngine("firecrawl", { ok: true, blocks: [] });
		const doc = await walk([first, second]);
		assert.equal(doc.via, "rapidocr");
		assert.equal(second.calls, 0);
	});

	it("所有引擎都说不适用 → 补一句格式说明，而不是留空", async () => {
		const engines = [
			fakeEngine("firecrawl", { ok: false, notApplicable: true }),
			fakeEngine("rapidocr", { ok: false, notApplicable: true }),
		];
		await assert.rejects(
			() => walk(engines),
			(err: Error & { engineHints?: string[] }) => {
				assert.match((err.engineHints ?? []).join("|"), /no configured OCR engine can read this kind of document/);
				return true;
			},
		);
	});

	it("部分不适用 + 别的引擎有原因 → 不出现格式说明句（那会误导）", async () => {
		const engines = [
			fakeEngine("firecrawl", { ok: false, hint: "the API key was rejected" }),
			fakeEngine("rapidocr", { ok: false, notApplicable: true }),
		];
		await assert.rejects(
			() => walk(engines),
			(err: Error & { engineHints?: string[] }) => {
				const all = (err.engineHints ?? []).join("|");
				assert.match(all, /rejected/);
				assert.doesNotMatch(all, /can read this kind of document/);
				return true;
			},
		);
	});

	it("引擎报取消 → 立即停，错误带 cancelled", async () => {
		const first = fakeEngine("firecrawl", { ok: false, cancelled: true });
		const second = fakeEngine("rapidocr", { ok: true, blocks: [] });
		await assert.rejects(
			() => walk([first, second]),
			(err: Error & { cancelled?: boolean }) => {
				assert.equal(err.cancelled, true);
				assert.equal(err.message, "read cancelled");
				return true;
			},
		);
		assert.equal(second.calls, 0, "取消后不再试下一个");
	});

	it("进入引擎前发现已中止 → 一个都不问（取消后绝不发起上传）", async () => {
		const engine = fakeEngine("firecrawl", { ok: true, blocks: [] });
		const ctrl = new AbortController();
		ctrl.abort();
		await assert.rejects(
			() => walk([engine], { signal: ctrl.signal }),
			(err: Error & { cancelled?: boolean }) => err.cancelled === true,
		);
		assert.equal(engine.calls, 0);
	});

	it("pageCount<=0 → 不尝试任何引擎（无法归属的块自相矛盾）", async () => {
		const engine = fakeEngine("rapidocr", { ok: true, blocks: [] });
		await assert.rejects(
			() =>
				convertDocument("a.pdf", ".pdf", {
					parse: async () => {
						throw needsOcrError([], 0);
					},
					engines: [engine],
				}),
			(err: Error & { code?: string }) => err.code === "needsOcr",
		);
		assert.equal(engine.calls, 0);
	});

	it("配置非法 → 抛 ocrNeeded + configLegal，且先于页数守卫", async () => {
		const engine = fakeEngine("rapidocr", { ok: true, blocks: [] });
		await assert.rejects(
			() =>
				convertDocument(
					"a.pdf",
					".pdf",
					{
						parse: async () => {
							throw needsOcrError([], 0);
						},
						engines: [engine],
					},
					{ configInvalid: { legal: "firecrawl, rapidocr, off" } },
				),
			(err: Error & { ocrNeeded?: boolean; configLegal?: string }) => {
				assert.equal(err.ocrNeeded, true, "确实需要 OCR 才值得说配置问题");
				assert.match(err.configLegal ?? "", /off/);
				return true;
			},
		);
		assert.equal(engine.calls, 0);
	});

	it("引擎列表为空 → 仍然是 needsOcr 错误，但标了 ocrNeeded", async () => {
		await assert.rejects(
			() => walk([]),
			(err: Error & { code?: string; ocrNeeded?: boolean }) => {
				assert.equal(err.code, "needsOcr");
				assert.equal(err.ocrNeeded, true);
				return true;
			},
		);
	});

	it("非 needsOcr 的错误原样抛（不触发任何降级）", async () => {
		const engine = fakeEngine("rapidocr", { ok: true, blocks: [] });
		await assert.rejects(
			() =>
				convertDocument("a.pdf", ".pdf", {
					parse: async () => {
						throw new Error("corrupt file");
					},
					engines: [engine],
				}),
			/corrupt file/,
		);
		assert.equal(engine.calls, 0);
	});

	it("引擎拿到完整上下文（path/ext/pages/pageCount/now）", async () => {
		const engine = fakeEngine("rapidocr", { ok: true, blocks: [] });
		await walk([engine], { now: new Date(2026, 0, 2) });
		const ctx = engine.contexts[0];
		assert.equal(ctx?.path, "a.pdf");
		assert.equal(ctx?.ext, ".pdf");
		assert.deepEqual(ctx?.pages, [1, 3]);
		assert.equal(ctx?.pageCount, 4);
		assert.equal(ctx?.now.getFullYear(), 2026);
	});

	it("joinHints：滤空、去重、按序用 · 连接", () => {
		assert.equal(joinHints(["a", undefined, "b"]), "a · b");
		assert.equal(joinHints(["a", "a"]), "a");
		assert.equal(joinHints([undefined, ""]), "");
	});
});
