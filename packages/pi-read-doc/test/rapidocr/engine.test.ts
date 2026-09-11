import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OCR_BATCH, recoverPdf } from "../../ocr/engines/rapidocr/engine.js";
import type { OcrPage, PageOcr } from "../../ocr/engines/rapidocr/page.js";
import type { PdfTools } from "../../pdf/poppler.js";

function fakePdf(
	opts: {
		available?: boolean;
		textLayers?: number[];
		renderFails?: number[];
		separateResult?: string[];
		onSeparate?: () => void;
		/** 真 pdfseparate 被预算掐死要花掉时间；用它模拟"调用本身超预算"。 */
		separateDelayMs?: number;
	} = {},
) {
	const calls = {
		separate: 0,
		unite: [] as string[][],
		render: [] as number[],
		renderOpts: [] as { dpi: number; maxPx: number; format: string }[],
		pageTexts: 0,
		/** Every per-step timeout the recovery asked for. */
		stepTimeouts: [] as number[],
		/** The abort signal each step was given. */
		stepSignals: [] as (AbortSignal | undefined)[],
	};
	const pdf: PdfTools = {
		// Like the real adapter: a probe that was aborted, or that has ~1ms to
		// work with, cannot answer — false, not "not installed".
		available: async (runOpts?: { timeoutMs?: number; signal?: AbortSignal }) => {
			if (runOpts?.signal?.aborted) return false;
			if ((runOpts?.timeoutMs ?? 1_000) <= 1) return false;
			return opts.available ?? true;
		},
		pageTexts: async (_p, runOpts?: { timeoutMs?: number; signal?: AbortSignal }) => {
			calls.pageTexts++;
			if (runOpts?.timeoutMs !== undefined) calls.stepTimeouts.push(runOpts.timeoutMs);
			calls.stepSignals.push(runOpts?.signal);
			const layer = Array.from({ length: 500 }, () => "");
			for (const p of opts.textLayers ?? []) layer[p - 1] = "real text layer";
			return layer;
		},
		separate: async (_p, count, dir, runOpts?: { timeoutMs?: number; signal?: AbortSignal }) => {
			calls.separate++;
			if (opts.separateDelayMs) await new Promise((r) => setTimeout(r, opts.separateDelayMs));
			opts.onSeparate?.();
			if (opts.separateResult) return opts.separateResult;
			if (runOpts?.timeoutMs !== undefined) calls.stepTimeouts.push(runOpts.timeoutMs);
			calls.stepSignals.push(runOpts?.signal);
			return Array.from({ length: count }, (_, i) => `${dir}/p-${i + 1}.pdf`);
		},
		unite: async (files, _out, opts?: { timeoutMs?: number; signal?: AbortSignal }) => {
			calls.unite.push(files);
			if (opts?.timeoutMs !== undefined) calls.stepTimeouts.push(opts.timeoutMs);
			calls.stepSignals.push(opts?.signal);
		},
		pageSizes: async () => Array.from({ length: 500 }, () => ({ w: 612, h: 792 })),
		render: async (_p, page, dir, renderOpts) => {
			calls.render.push(page);
			calls.renderOpts.push(renderOpts);
			if (renderOpts.timeoutMs !== undefined) calls.stepTimeouts.push(renderOpts.timeoutMs);
			calls.stepSignals.push(renderOpts.signal);
			if ((opts.renderFails ?? []).includes(page)) return null;
			return `${dir}/page-${page}${renderOpts.format === "jpeg" ? ".jpg" : ".png"}`;
		},
	};
	return { pdf, calls };
}

function fakeEngine(
	opts: { available?: boolean; pages?: OcrPage[]; onRun?: () => void; fail?: "timeout" | "failed" } = {},
) {
	const calls = { available: 0, recognize: [] as string[][], timeouts: [] as number[] };
	const engine: PageOcr = {
		installHint: () => "install fake",
		available: async (runOpts?: { timeoutMs?: number; signal?: AbortSignal }) => {
			calls.available++;
			if (runOpts?.timeoutMs !== undefined) calls.timeouts.push(runOpts.timeoutMs);
			if (runOpts?.signal?.aborted) return false;
			return opts.available ?? true;
		},
		recognize: async (images, runOpts) => {
			calls.recognize.push(images);
			if (runOpts?.timeoutMs !== undefined) calls.timeouts.push(runOpts.timeoutMs);
			opts.onRun?.();
			if (opts.fail) return { ok: false, reason: opts.fail };
			return { ok: true, pages: opts.pages ?? images.map(() => ({ text: "recognized text" })) };
		},
	};
	return { engine, calls };
}

const deps = (over: Partial<Parameters<typeof recoverPdf>[3]> = {}) => {
	const { pdf, calls: pdfCalls } = fakePdf();
	const { engine, calls: engineCalls } = fakeEngine();
	return {
		pdfCalls,
		engineCalls,
		base: {
			pdf,
			engine,
			convertSubset: async (p: string) => `markdown of ${p}`,
			dirs: { scratch: "/tmp/scratch", artifacts: "/tmp/art" },
			...over,
		},
	};
};

describe("recoverPdf — 本地恢复协调", () => {
	it("混合档：文字段走 anydoc，扫描页渲染 + 批量 OCR，按页序拼装", async () => {
		const { base, pdfCalls, engineCalls } = deps();
		const r = await recoverPdf("/x.pdf", [3, 5], 6, base);
		assert.ok(r.ok);
		assert.deepEqual(
			r.blocks.map((b) => [b.pages, b.text === "" ? b.note : "text"]),
			[
				[[1, 2], "text"],
				[[3], "text"],
				[[4], "text"],
				[[5], "text"],
				[[6], "text"],
			],
		);
		assert.equal(pdfCalls.separate, 1, "拆一次，多个 run 复用");
		assert.equal(pdfCalls.unite.length, 3, "三个文字段 → 三次 pdfunite");
		assert.deepEqual(pdfCalls.render, [3, 3, 5, 5], "每页渲染两次：OCR 输入 + 给模型的观察副本");
		assert.deepEqual(
			engineCalls.recognize,
			[["/tmp/scratch/page-3.png", "/tmp/scratch/page-5.png"]],
			"一批读完（OCR 用 scratch 里的图）",
		);
		const ocr3 = r.blocks.find((b) => b.pages[0] === 3);
		assert.equal(ocr3?.image, "/tmp/art/page-3.jpg", "给模型的路径是 artifacts 里的观察副本");
		assert.equal(ocr3?.note, undefined, "有文字就不带 note：来源已由 image 字段自证，「OCR 可能读错」是模型自己的先验");
	});

	it("OCR 分批：一批最多 OCR_BATCH 页，磁盘与时间都被批次约束", async () => {
		const pages = Array.from({ length: OCR_BATCH * 2 + 1 }, (_, i) => i + 1);
		const { base, engineCalls } = deps();
		const r = await recoverPdf("/x.pdf", pages, pages.length, { ...base, budgetMs: 600_000 });
		assert.ok(r.ok);
		assert.deepEqual(
			engineCalls.recognize.map((b) => b.length),
			[OCR_BATCH, OCR_BATCH, 1],
			"3 批，而不是一次性渲染全部",
		);
	});

	it("时间预算：到点即停，未处理的页进 note（是部分结果，不是失败）", async () => {
		const { base } = deps();
		const r = await recoverPdf("/x.pdf", [1, 2, 3], 3, { ...base, budgetMs: 0 });
		assert.ok(r.ok, "预算耗尽不是错误");
		assert.ok(
			r.blocks.every((b) => b.text === ""),
			"什么都没读到",
		);
		assert.match(r.blocks[0]?.note ?? "", /time budget/);
		assert.deepEqual(r.blocks[0]?.pages, [1, 2, 3], "缺了哪些页写清楚");
	});

	it("探测也受预算约束（挂死的 poppler -v 不能无限期拖住整次读取）", async () => {
		const { base, pdfCalls } = deps();
		await recoverPdf("/x.pdf", [1], 1, { ...base, budgetMs: 4_000 });
		assert.ok(
			pdfCalls.stepTimeouts.every((t) => t <= 4_000),
			`探测与每一步都在预算内: ${JSON.stringify(pdfCalls.stepTimeouts)}`,
		);
	});

	it("中止信号传导到 poppler 的每一步（Esc 不该只打断 OCR）", async () => {
		const controller = new AbortController();
		const { base, pdfCalls } = deps();
		await recoverPdf("/x.pdf", [3], 3, { ...base, signal: controller.signal });
		assert.ok(pdfCalls.stepSignals.length >= 3, `每步都带 signal: ${pdfCalls.stepSignals.length}`);
		assert.ok(
			pdfCalls.stepSignals.every((s) => s === controller.signal),
			"传的就是同一个 signal",
		);
	});

	it("每一步的超时都受总预算约束（单步的固定上限不能吹爆它）", async () => {
		const { base, pdfCalls } = deps();
		await recoverPdf("/x.pdf", [3], 3, { ...base, budgetMs: 5_000 });
		assert.ok(pdfCalls.stepTimeouts.length >= 3, `每步都带预算: ${JSON.stringify(pdfCalls.stepTimeouts)}`);
		for (const t of pdfCalls.stepTimeouts) assert.ok(t <= 5_000, `单步超时 ${t} 不得超过总预算`);
	});

	it("预算会传导给引擎（探测与识别都用剩余预算），不会各步各自为政", async () => {
		const { base, engineCalls } = deps();
		await recoverPdf("/x.pdf", [1], 1, { ...base, budgetMs: 5_000 });
		assert.equal(engineCalls.timeouts.length, 2, "探测一次 + 识别一次");
		for (const t of engineCalls.timeouts) {
			assert.ok(t <= 5_000, `不超过总预算: ${t}`);
			assert.ok(t > 0);
		}
	});

	it("Esc 中止：不再往下走，带 cancelled 返回而不是假装读完", async () => {
		const controller = new AbortController();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine({ onRun: () => controller.abort() });
		const r = await recoverPdf("/x.pdf", [1, 2], 2, {
			pdf,
			engine,
			convertSubset: async () => "md",
			dirs: { scratch: "/s", artifacts: "/a" },
			signal: controller.signal,
		});
		assert.deepEqual(r, { ok: false, reason: "cancelled" });
	});

	it("步骤因中止而失败 → 报 cancelled，不冒充工具缺失或文档损坏", async () => {
		const controller = new AbortController();
		const { pdf } = fakePdf({ onSeparate: () => controller.abort(), separateResult: [] });
		const { engine } = fakeEngine();
		const r = await recoverPdf("/x.pdf", [3], 3, {
			pdf,
			engine,
			convertSubset: async () => "md",
			dirs: { scratch: "/s", artifacts: "/a" },
			signal: controller.signal,
		});
		assert.deepEqual(r, { ok: false, reason: "cancelled" }, "中止不是 failed，更不是 poppler-missing");
	});

	it("anydoc 调用受预算约束（它自身不超时，我们不等它超）", async () => {
		const { base, pdfCalls } = deps();
		const started = Date.now();
		const r = await recoverPdf("/x.pdf", [3], 3, {
			...base,
			budgetMs: 300,
			convertSubset: () => new Promise<string>(() => {}), // 永不 resolve
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 2_000, `不能陪着它无限期等（实测 ${elapsed}ms）`);
		assert.ok(r.ok, "这是局部缺页，不是整次失败");
		assert.match(r.blocks[0]?.note ?? "", /conversion failed|budget/, "缺的那段要如实标注");
		assert.ok(pdfCalls.stepTimeouts.length > 0, "预算确实传下去了");
	});

	it("预算耗尽导致探测失败 → 记缺页，绝不谎报『引擎没装』", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine({ available: false });
		const r = await recoverPdf("/x.pdf", [1, 2], 2, {
			...base,
			pdf,
			engine,
			budgetMs: 0, // 探测根本没机会跑
		});
		assert.ok(r.ok, "预算是局部缺页，不是整次失败");
		assert.match(r.blocks[0]?.note ?? "", /time budget/);
		assert.ok(!JSON.stringify(r).includes("install fake"), "不能给出『去装引擎』这种与事实相反的指引");
	});

	it("poppler 探测被预算饿死 → 缺页，不是『去装 poppler』", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine();
		const r = await recoverPdf("/x.pdf", [1, 2], 2, { ...base, pdf, engine, budgetMs: 0 });
		assert.ok(r.ok, "预算耗尽 = 部分结果");
		assert.equal(r.blocks[0]?.note, "not read: time budget");
		assert.deepEqual(r.blocks[0]?.pages, [1, 2], "所有页都要交代");
		assert.ok(!JSON.stringify(r).includes("poppler-is-missing-install-it"), "不能谎报缺工具");
	});

	it("pdfseparate 被预算掐死（返回空）→ 记缺页，不是硬失败", async () => {
		const { base } = deps();
		const { pdf } = fakePdf({ separateResult: [], separateDelayMs: 450 });
		const { engine } = fakeEngine();
		const r = await recoverPdf("/x.pdf", [3], 3, { ...base, pdf, engine, budgetMs: 400 });
		assert.ok(r.ok, "不是 {ok:false, reason:'failed'}");
		assert.match(r.blocks.map((b) => b.note ?? "").join("|"), /time budget/, "文字段要如实记为未读");
	});

	it("把进度报出去：一页扫描要几秒，卡片不能全程沉默", async () => {
		const notes: string[] = [];
		const { base } = deps({ onProgress: (n: string) => notes.push(n) });
		await recoverPdf("/x.pdf", [2, 3], 4, { ...base, budgetMs: 600_000 });
		assert.ok(
			notes.some((n) => n === "local OCR: 2 of 4 pages"),
			`要先说总量：${notes.join(" | ")}`,
		);
		assert.ok(
			notes.some((n) => /^local OCR: page [23] of 4/.test(n)),
			`再说当前页：${notes.join(" | ")}`,
		);
	});

	it("一开始就已中止：立刻返回，不探测不渲染", async () => {
		const controller = new AbortController();
		controller.abort();
		const { pdf, calls } = fakePdf();
		const { engine, calls: engineCalls } = fakeEngine();
		const r = await recoverPdf("/x.pdf", [1], 1, {
			pdf,
			engine,
			convertSubset: async () => "md",
			dirs: { scratch: "/s", artifacts: "/a" },
			signal: controller.signal,
		});
		assert.deepEqual(r, { ok: false, reason: "cancelled" });
		assert.equal(calls.render.length + calls.separate + engineCalls.available, 0);
	});

	it("中止卡在 poppler 探测上（适配器答 false）→ 仍是 cancelled 失败，不是带缺页的成功", async () => {
		// 真适配器被中止时对 available() 答 false。这条路曾被并进"预算耗尽"
		// 分支，于是 Esc 变成一次"成功读取，内容全是 not read: cancelled"。
		const controller = new AbortController();
		controller.abort();
		const { base } = deps();
		const r = await recoverPdf("/x.pdf", [1, 2], 2, { ...base, signal: controller.signal });
		assert.deepEqual(r, { ok: false, reason: "cancelled" }, "中止是失败，不是部分结果");
	});

	it("中止撞在引擎探测上 → 同样是 cancelled", async () => {
		const controller = new AbortController();
		const { base } = deps();
		const engine: PageOcr = {
			installHint: () => "install fake",
			available: async () => {
				controller.abort();
				return false;
			},
			recognize: async () => ({ ok: true, pages: [] }),
		};
		const r = await recoverPdf("/x.pdf", [1], 1, { ...base, engine, signal: controller.signal });
		assert.deepEqual(r, { ok: false, reason: "cancelled" });
	});

	it("标记的页都有文字层（全是误判）→ 一段文字层，根本不探测引擎", async () => {
		const { pdf, calls } = fakePdf({ textLayers: [2, 4] });
		const { engine, calls: engineCalls } = fakeEngine({ available: false });
		const r = await recoverPdf("/x.pdf", [2, 4], 5, {
			pdf,
			engine,
			convertSubset: async () => "md",
			dirs: { scratch: "/s", artifacts: "/a" },
		});
		assert.ok(r.ok);
		assert.deepEqual(
			r.blocks.map((b) => b.pages),
			[[1, 2, 3, 4, 5]],
			"误判页并回文字段（合并规则见 plan.test.ts）",
		);
		assert.equal(calls.render.length, 0, "没有需要 OCR 的页");
		assert.equal(engineCalls.available, 0, "不必要就不探测引擎");
	});

	it("poppler 缺失 → 带原因失败，别的一概不试", async () => {
		const { pdf, calls } = fakePdf({ available: false });
		const { engine, calls: engineCalls } = fakeEngine();
		const r = await recoverPdf("/x.pdf", [1], 1, {
			pdf,
			engine,
			convertSubset: async () => "md",
			dirs: { scratch: "/s", artifacts: "/a" },
		});
		assert.equal(r.ok, false);
		assert.equal(r.ok === false ? r.reason : "", "poppler-missing");
		// The install guidance now comes from the engine that needs the tool
		// (it used to be looked up by reason in index.ts).
		assert.match(r.ok === false ? (r.hint ?? "") : "", /poppler/, "缺 poppler 要说清怎么装");
		assert.equal(calls.separate + calls.render.length + engineCalls.available, 0);
	});

	it("引擎缺失（确实有页要 OCR）→ engine-missing，不白渲染", async () => {
		const { base, pdfCalls } = deps();
		const { pdf, calls } = fakePdf();
		const { engine } = fakeEngine({ available: false });
		const r = await recoverPdf("/x.pdf", [1, 2], 2, { ...base, pdf, engine });
		assert.deepEqual(r, { ok: false, reason: "engine-missing", hint: "install fake" }, "引擎自带安装指引");
		assert.equal(pdfCalls.render.length + calls.render.length, 0, "缺引擎就不渲染");
	});

	it("整页无文字 → text 为空 + 说明，页图仍然留给模型回看", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine({ pages: [{ text: "" }] });
		const r = await recoverPdf("/x.pdf", [1], 1, { ...base, pdf, engine });
		assert.ok(r.ok);
		assert.equal(r.blocks[0]?.text, "");
		assert.equal(r.blocks[0]?.note, "no text found in the page image");
		assert.equal(r.blocks[0]?.image, "/tmp/art/page-1.jpg");
	});

	it("识别得少也照样进 text —— 没有任何阈值可以把读到的改写成没有", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine({ pages: [{ text: "_" }] });
		const r = await recoverPdf("/x.pdf", [1], 1, { ...base, pdf, engine });
		assert.ok(r.ok);
		assert.equal(r.blocks[0]?.text, "_", "读到了就是读到了");
		assert.equal(r.blocks[0]?.note, undefined, "读到了就不写 note：可不可信不由我们代为判断");
	});

	it("两档渲染：OCR 用 200dpi/PNG 进 scratch，给模型的用 150dpi/JPEG 进 artifacts", async () => {
		const { base, pdfCalls } = deps();
		await recoverPdf("/x.pdf", [1], 1, base);
		assert.deepEqual(
			pdfCalls.renderOpts.map((o) => [o.dpi, o.format]),
			[
				[200, "png"], // OCR 输入
				[136, "jpeg"], // 观察副本：150dpi 被 1500px 上限压到 136（letter 页）
			],
		);
	});

	it("探测只调用一次（不是每标记页一次）", async () => {
		const { base, pdfCalls } = deps();
		await recoverPdf("/x.pdf", [1, 2, 3, 4, 5], 5, base);
		assert.equal(pdfCalls.pageTexts, 1, "N 个标记页仍然只探一次");
	});

	it("OCR 超时 → 已完成的页照常交付，其余标 timeout", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine({ pages: [{ text: "page one text" }, { text: "", error: "timeout" }] });
		const r = await recoverPdf("/x.pdf", [1, 2], 2, { ...base, pdf, engine });
		assert.ok(r.ok);
		assert.equal(r.blocks[0]?.text, "page one text");
		assert.match(r.blocks[1]?.note ?? "", /timeout/);
	});

	it("整批都读不出来 → 每页记原因，不是静默空白", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine({ fail: "timeout" });
		const r = await recoverPdf("/x.pdf", [1, 2], 2, { ...base, pdf, engine });
		assert.ok(r.ok);
		assert.deepEqual(r.blocks[0]?.pages, [1, 2]);
		assert.match(r.blocks[0]?.note ?? "", /timeout/);
	});

	it("渲染失败的页 → note，其余照常", async () => {
		const { base } = deps();
		const { pdf } = fakePdf({ renderFails: [2] });
		const { engine } = fakeEngine();
		const r = await recoverPdf("/x.pdf", [1, 2], 2, {
			...base,
			pdf,
			engine,
			convertSubset: async () => {
				throw new Error("no text run here");
			},
		});
		assert.ok(r.ok);
		assert.equal(r.blocks.find((b) => b.pages[0] === 2)?.note, "not read: page could not be rendered");
		assert.equal(r.blocks.find((b) => b.pages[0] === 1)?.text, "recognized text");
	});

	it("某个文字段转换失败 → 该段记 note，其余页不受影响", async () => {
		const { base } = deps();
		const { pdf } = fakePdf();
		const { engine } = fakeEngine();
		let call = 0;
		const r = await recoverPdf("/x.pdf", [3], 5, {
			...base,
			pdf,
			engine,
			convertSubset: async () => {
				call++;
				if (call === 1) throw new Error("encrypted part");
				return "md";
			},
		});
		assert.ok(r.ok);
		assert.match(r.blocks.find((b) => b.pages[0] === 1)?.note ?? "", /conversion failed/);
		assert.equal(r.blocks.find((b) => b.pages[0] === 4)?.text, "md");
		assert.equal(r.blocks.find((b) => b.pages[0] === 3)?.text, "recognized text");
	});
});
