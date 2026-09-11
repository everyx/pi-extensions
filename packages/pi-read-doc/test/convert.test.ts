/**
 * Tests for the conversion chain (convert.ts): the fallback order (anydoc →
 * hosted → local recovery) and the shape each path returns. Fake deps — no
 * anydoc engine, no network, no poppler, no OCR. What is not the chain has its
 * own tests: `hosted-gate.test.ts`, `page-labels.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ConvertDeps, convertDocument, type LocalFailure } from "../convert.js";
import type { HostedGate, HostedSkip } from "../hosted-gate.js";
import type { RecoveredBlock, Recovery } from "../pdf/recover.js";

function needsOcrError(
	pages: number[],
	pageCount?: number,
): Error & { code: string; pages: number[]; pageCount: number } {
	const e = new Error("scanned pages need OCR") as Error & { code: string; pages: number[]; pageCount: number };
	e.code = "needsOcr";
	e.pages = pages;
	e.pageCount = pageCount ?? Math.max(...pages, 0);
	return e;
}

/** A gate that records what it was told; `parked` seeds the skip state. */
function fakeGate(parked: HostedSkip | null = null) {
	const recorded: HostedSkip[] = [];
	const gate: HostedGate = {
		async skipped() {
			return parked;
		},
		async record(skip) {
			recorded.push(skip);
		},
	};
	return { gate, recorded };
}

interface DepsHarness extends ConvertDeps {
	mdCalls: number;
	hostedCalls: number;
	recovered: { path: string; flagged: number[]; pageCount: number }[];
	hostedErrors: Error[];
}

function harness(
	overrides: {
		mdResult?: string | (() => Promise<string>);
		hostedResult?: string | (() => Promise<string>);
		recovery?: Recovery;
		gate?: HostedGate;
	} = {},
): DepsHarness {
	const { gate } = fakeGate();
	const h: DepsHarness = {
		mdCalls: 0,
		hostedCalls: 0,
		recovered: [],
		hostedErrors: [],
		toMarkdown: async (_path, opts) => {
			h.mdCalls++;
			if (opts?.ocr === "hosted") {
				h.hostedCalls++;
				const r = overrides.hostedResult;
				if (typeof r === "function") return r();
				if (typeof r === "string") return r;
				const err = new Error("Firecrawl Parse: 500");
				h.hostedErrors.push(err);
				throw err;
			}
			const r = overrides.mdResult;
			if (typeof r === "function") return r();
			if (typeof r === "string") return r;
			throw needsOcrError([1, 2]);
		},
		hosted: overrides.gate ?? gate,
		limit: async (fn) => fn(),
		recover: async (path, flagged, pageCount) => {
			h.recovered.push({ path, flagged, pageCount });
			// Mirrors the real recovery: an engine-missing failure carries the
			// engine's own install guidance.
			return overrides.recovery ?? { ok: false, reason: "engine-missing", hint: "install fake" };
		},
	};
	return h;
}

const block = (pages: number[], text: string, image?: string): RecoveredBlock => ({
	pages,
	text,
	...(image ? { image } : {}),
});

describe("convertDocument — chain", () => {
	it("anydoc 本地成功 → markdown，不碰 hosted、不碰恢复", async () => {
		const h = harness({ mdResult: "# doc" });
		const doc = await convertDocument("a.docx", ".docx", h);
		assert.equal(doc.kind, "markdown");
		assert.equal(doc.via, "anydoc");
		assert.deepEqual(doc.kind === "markdown" && doc.text, "# doc");
		assert.equal(h.hostedCalls, 0);
		assert.deepEqual(h.recovered, []);
	});

	it("needsOcr → hosted 成功 → 块形态 + 说明（不再是无标注的纯 markdown）", async () => {
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([3], 3)),
			hostedResult: "parse markdown",
		});
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(doc.kind, "blocks");
		assert.equal(doc.via, "anydoc:hosted");
		assert.deepEqual(doc.blocks, [
			{ pages: [1, 2, 3], text: "parse markdown", note: "pages 3 were read by OCR — may misread" },
		]);
		assert.deepEqual(h.recovered, [], "hosted 成功后不再本地恢复");
	});

	it("hosted 失败 → 落到本地恢复（保持既有顺序）", async () => {
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([3], 3)),
			recovery: { ok: true, blocks: [block([3], "ocr text", "/tmp/a/page-3.jpg")] },
		});
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(doc.via, "local");
		assert.deepEqual(h.recovered, [{ path: "a.pdf", flagged: [3], pageCount: 3 }]);
	});

	it("配额信号 → 记录停摆，并在结果上留下原因", async () => {
		const { gate, recorded } = fakeGate();
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([1], 1)),
			hostedResult: () => Promise.reject(new Error("Firecrawl Parse is out of credits: nope")),
			recovery: { ok: true, blocks: [block([1], "local")] },
			gate,
		});
		const doc = await convertDocument("a.pdf", ".pdf", h, { now: new Date(2026, 8, 11) });
		assert.equal(recorded.length, 1, "记下停摆");
		assert.match(recorded[0]?.reason ?? "", /credits exhausted/);
		assert.equal(new Date(recorded[0]?.until ?? 0).getMonth(), 9, "停到 10 月");
		assert.match(doc.hint ?? "", /hosted OCR paused/);
	});

	it("门已停摆 + 本地也失败 → 用户仍能看到停摆原因", async () => {
		const { gate } = fakeGate({ until: Date.now() + 86_400_000, reason: "credits exhausted" });
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([1], 1)),
			recovery: { ok: false, reason: "poppler-missing" },
			gate,
		});
		await assert.rejects(
			() => convertDocument("a.pdf", ".pdf", h),
			(err: Error & { hostedHint?: string }) => {
				assert.match(err.hostedHint ?? "", /paused|credits exhausted/, "本地失败不能吞掉停摆原因");
				return true;
			},
		);
	});

	it("门已停摆 → 根本不发起 hosted 请求", async () => {
		const { gate } = fakeGate({ until: Date.now() + 86_400_000, reason: "credits exhausted" });
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([1], 1)),
			recovery: { ok: true, blocks: [block([1], "local")] },
			gate,
		});
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.equal(h.hostedCalls, 0, "停摆期间不浪费请求也不上传");
		assert.match(doc.hint ?? "", /paused/);
	});

	it("key 被拒 → 本地恢复照样交付，但把配置问题留给用户", async () => {
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([1], 1)),
			hostedResult: () => Promise.reject(new Error("Firecrawl Parse rejected the API key: bad")),
			recovery: { ok: true, blocks: [block([1], "local")] },
		});
		const doc = await convertDocument("a.pdf", ".pdf", h);
		assert.match(doc.hint ?? "", /FIRECRAWL_API_KEY/, "坏 key 不能因为本地成功就消失");
	});

	it("key 被拒 + 本地恢复也失败 → 两条提示都在（不能互相吞掉）", async () => {
		const h = harness({
			mdResult: () => Promise.reject(needsOcrError([1], 1)),
			hostedResult: () => Promise.reject(new Error("Firecrawl Parse rejected the API key: bad")),
			recovery: { ok: false, reason: "engine-missing", hint: "install fake" },
		});
		await assert.rejects(
			() => convertDocument("a.pdf", ".pdf", h),
			(err: Error & { localReason?: string; localHint?: string; hostedHint?: string }) => {
				// The engine's guidance goes to localHint, the key problem to
				// hostedHint: one failing reason must not swallow the other.
				assert.equal(err.localReason, "engine-missing");
				assert.match(err.localHint ?? "", /install fake/);
				assert.match(err.hostedHint ?? "", /FIRECRAWL_API_KEY/);
				return true;
			},
		);
	});

	it("恢复失败 → 原 needsOcr 错误带 localReason 抛出", async () => {
		const h = harness({ recovery: { ok: false, reason: "engine-missing", hint: "install fake" } });
		await assert.rejects(
			() => convertDocument("a.pdf", ".pdf", h),
			(err: Error & { code?: string; localReason?: LocalFailure }) =>
				err.code === "needsOcr" && err.localReason === "engine-missing",
		);
	});

	it("没有页数的 needsOcr 错误不做恢复 —— 不静默丢页", async () => {
		const h = harness({
			mdResult: () => {
				const e = new Error("scanned") as Error & { code: string };
				e.code = "needsOcr";
				return Promise.reject(e);
			},
		});
		await assert.rejects(
			() => convertDocument("a.pdf", ".pdf", h),
			(err: Error & { code?: string }) => err.code === "needsOcr",
		);
		assert.deepEqual(h.recovered, []);
	});

	it("非 needsOcr 的错误原样抛出（不触发任何降级）", async () => {
		const h = harness({ mdResult: () => Promise.reject(new Error("corrupt file")) });
		await assert.rejects(() => convertDocument("a.pdf", ".pdf", h), /corrupt file/);
		assert.equal(h.hostedCalls, 0);
		assert.deepEqual(h.recovered, []);
	});
});
