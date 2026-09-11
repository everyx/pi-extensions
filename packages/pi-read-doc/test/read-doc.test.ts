import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksForLlm, blocksToText } from "../blocks.js";
import { conversionFailure, extOf, OFFICE_EXTS, ocrBudgetMs, truncateForLlm } from "../index.js";
import { createRateLimiter } from "../rate-limit.js";

describe("pi-read-doc", () => {
	it("ext detection", () => {
		assert.equal(extOf("a.docx"), ".docx");
		assert.equal(extOf("A.PDF"), ".pdf");
		assert.equal(extOf("noext"), "");
	});

	it("office ext set covers the anydoc table", () => {
		for (const ext of [".doc", ".docx", ".docm", ".pdf", ".xlsx", ".xlsm", ".pptx", ".odt", ".rtf", ".epub", ".csv"]) {
			assert.ok(OFFICE_EXTS.has(ext), `${ext} in OFFICE_EXTS`);
		}
		assert.ok(!OFFICE_EXTS.has(".ts"));
	});

	it("conversionFailure: terse LLM text, guidance on details.error (the rendered channel)", () => {
		const r = conversionFailure("PDF pages 1, 2 need OCR", { code: "needsOcr" });
		assert.equal(r.content[0]?.text, "PDF pages 1, 2 need OCR", "the LLM keeps the engine message alone");
		assert.match(r.details.error, /Scanned pages: run hosted OCR/);
		assert.ok(!("hint" in r.details), "no field the card never renders");
		assert.ok(!("code" in r.details), "nor one the card never renders either");
	});

	it("conversionFailure: 中止不是失败 —— 两边同一句话，卡片走 stop 而不是 ✗", () => {
		const r = conversionFailure("PDF pages 1, 2 need OCR", { code: "needsOcr", localReason: "cancelled" });
		assert.equal(r.content[0]?.text, "read cancelled", "模型听到的也是中止，不是引擎的 needsOcr");
		assert.equal(r.details.error, "read cancelled");
		assert.equal((r.details as { status?: string }).status, "stop", "用户按的 Esc 不该显示成读取失败");
	});

	it("conversionFailure: no guidance for codes the user cannot act on", () => {
		const r = conversionFailure("malformed: junk", { code: "malformed" });
		assert.equal(r.content[0]?.text, "malformed: junk");
		assert.equal(r.details.error, "malformed: junk");
	});

	it("rate limiter serializes and enforces the gap (qps<=0 passes through)", async () => {
		const lim = createRateLimiter(10); // 100ms gap
		let active = 0;
		let maxActive = 0;
		const run = lim(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 20));
			active--;
			return active;
		});
		const results = await Promise.all([run, run, run]);
		assert.deepEqual(results, [0, 0, 0]); // serialized: never concurrent
		assert.equal(maxActive, 1);

		// qps <= 0 disables throttling entirely (the real guard).
		const disabled = createRateLimiter(0);
		const t0 = Date.now();
		await disabled(async () => Promise.resolve());
		const dt = Date.now() - t0;
		assert.ok(dt < 500, `no artificial delay (took ${dt}ms)`);
	});
});

describe("LLM budget truncation (root SPEC: LLM context 截断保护)", () => {
	it("passes short text through unchanged", () => {
		const r = truncateForLlm("hello\nworld");
		assert.equal(r.text, "hello\nworld");
		assert.equal(r.truncated, false);
	});

	it("head-truncates at the line budget, with a marker", () => {
		const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
		const r = truncateForLlm(text);
		assert.equal(r.truncated, true);
		assert.ok(r.text.startsWith("line 0"));
		assert.ok(r.text.includes("line 1999"));
		assert.ok(!r.text.includes("line 2000"));
		assert.match(r.text, /truncated: first 2000 lines/);
	});

	it("head-truncates at the byte budget (whole lines kept)", () => {
		const text = Array.from({ length: 600 }, () => "x".repeat(100)).join("\n"); // 60,599 bytes
		const r = truncateForLlm(text);
		assert.equal(r.truncated, true);
		assert.ok(r.text.startsWith("x"));
		const body = r.text.split("\n(truncated:")[0];
		assert.ok(Buffer.byteLength(body, "utf-8") <= 50 * 1024, "body within the byte budget");
		assert.match(r.text, /truncated: first \d+ lines \/ \d+ bytes; total \d+ lines \/ \d+ bytes/);
	});

	it("counts UTF-8 bytes, not chars (CJK regression)", () => {
		// 500 lines × 50 CJK chars: 25,000 "chars" (fits a char proxy) but
		// 75,500 UTF-8 bytes (over budget) — must truncate.
		const text = Array.from({ length: 500 }, () => "文".repeat(50)).join("\n");
		const r = truncateForLlm(text);
		assert.equal(r.truncated, true);
		const body = r.text.split("\n(truncated:")[0];
		assert.ok(Buffer.byteLength(body, "utf-8") <= 50 * 1024);
		assert.ok(Buffer.byteLength(body, "utf-8") > 40 * 1024, "kept most of the budget");
	});
});

describe("blocksForLlm — 结构化结果的 LLM 预算", () => {
	it("预算内原样保留（页序不变）", () => {
		const blocks = [
			{ pages: [1, 2], text: "md" },
			{ pages: [3], text: "ocr", image: "/tmp/a/page-3.png" },
		];
		const { json } = blocksForLlm(blocks);
		// 出线形态：页号压成 "1-2"，空字段省略
		assert.deepEqual(JSON.parse(json), [
			{ pages: "1-2", text: "md" },
			{ pages: "3", text: "ocr", image: "/tmp/a/page-3.png" },
		]);
	});

	it("超预算时丢块并标注，JSON 仍然合法（截断发生在序列化之前）", () => {
		const big = "x".repeat(800);
		const blocks = [
			{ pages: [1], text: "keep" }, // 序列化后 ~26B
			{ pages: [2], text: big }, // ~90B，超出剩余预算
			{ pages: [3], text: "also keep" }, // ~31B
		];
		// 预算是按"整块序列化后"算的（含 pages 包裹），并给省略说明留了余量
		const json = blocksForLlm(blocks, 900).json;
		assert.ok(Buffer.byteLength(json, "utf-8") <= 900, "整串（含标注块）不超预算");
		const parsed = JSON.parse(json) as { pages: string; text?: string; note?: string }[];
		assert.deepEqual(parsed[0]?.text, "keep");
		assert.deepEqual(parsed[2]?.text, "also keep", "小块不被大块饿死（跳过而非终止）");
		// 被丢的页进标注块，绝不静默消失——而且仍旧按页序插在原位
		assert.equal(parsed[1]?.pages, "2");
		assert.match(parsed[1]?.note ?? "", /read but omitted: output budget/, "这些页读过，只是没放进回复");
		assert.deepEqual(
			parsed.map((b) => b.pages),
			["1", "2", "3"],
			"数组按页序（SPEC 的契约）",
		);
	});

	it("空输入 → 空数组", () => {
		assert.equal(blocksForLlm([]).json, "[]");
	});
});

describe("ocrBudgetMs — 本地恢复的时间预算（PI_READ_DOC_OCR_TIMEOUT_MS）", () => {
	it("未设置 / 非法 / 非正数 → 默认预算", () => {
		delete process.env.PI_READ_DOC_OCR_TIMEOUT_MS;
		assert.equal(ocrBudgetMs(), 120_000);
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "abc";
		assert.equal(ocrBudgetMs(), 120_000);
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "0";
		assert.equal(ocrBudgetMs(), 120_000, "0 不是「不限制」，是配置错误");
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "-5";
		assert.equal(ocrBudgetMs(), 120_000);
		delete process.env.PI_READ_DOC_OCR_TIMEOUT_MS;
	});

	it("合法值生效", () => {
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "30000";
		assert.equal(ocrBudgetMs(), 30_000);
		delete process.env.PI_READ_DOC_OCR_TIMEOUT_MS;
	});
});

describe("blocksToText — 卡片的人读形态（JSON 只给模型）", () => {
	it("页头 + 文本 + 页图路径；单页用 Page N，跨页用范围", () => {
		const text = blocksToText([
			{ pages: [1, 2], text: "# 合同\n正文" },
			{ pages: [3], text: "OCR 文本", image: "/tmp/art/page-3.png" },
		]);
		assert.equal(text, "## Page 1-2\n# 合同\n正文\n\n## Page 3\nOCR 文本\n[source page image: /tmp/art/page-3.png]");
	});

	// 「文本 + note 并存」的那条旧用例已删：note 现在只在没有文字时出现（见
	// recover.ts），真实载荷里不再有这种组合——上面第一条已经钉住了有文字时
	// 的块形态（页头 + 文本 + 页图路径）。

	it("没有文字的页显示原因，而不是留白（离散页号也紧凑）", () => {
		const text = blocksToText([{ pages: [21, 137], text: "", note: "not read: time budget" }]);
		assert.equal(text, "## Page 21, 137\n(not read: time budget)");
	});

	it("空输入 → 空串（不编造页头）", () => {
		assert.equal(blocksToText([]), "");
	});
});

describe("blocksForLlm — 标注块也受预算约束", () => {
	it("上千种不同的 note 也不会把 JSON 撑爆", () => {
		// 每页一个不同的 note（引擎逐页报错时可以这样），标注块本身也必须进预算
		// 离散页号：连续页会被 formatPages 压成 "1-2000"，掩盖最坏情况
		const many = Array.from({ length: 2000 }, (_, i) => ({
			pages: [100_000 + i * 2],
			text: `body ${i}`,
			note: i % 2 === 0 ? `not read: engine error ${i}` : "",
		})).map((b) => (b.note === "" ? { pages: b.pages, text: "", note: `not read: engine error ${b.pages[0]}` } : b));
		const json = blocksForLlm(many, 51_200).json;
		assert.ok(Buffer.byteLength(json, "utf-8") <= 51_200, `实测 ${Buffer.byteLength(json, "utf-8")} 字节`);
		assert.ok(json.includes("also omitted: output budget"), "被挤掉的说明合并成一条，不静默消失");
	});
});

describe("blocksForLlm — 省略说明插在原位（页序是契约）", () => {
	it("被丢的页夹在保留页之间时，数组仍是严格页序", () => {
		const big = "x".repeat(300);
		const blocks = [
			{ pages: [1], text: "keep one" },
			{ pages: [2], text: big },
			{ pages: [3], text: "keep three" },
			{ pages: [4], text: big },
			{ pages: [5], text: "keep five" },
		];
		const parsed = JSON.parse(blocksForLlm(blocks, 700).json) as { pages: string; text?: string }[];
		// 2 与 4 被省略：各自作为一段，插在它们本来所在的位置上
		assert.deepEqual(
			parsed.map((b) => b.pages),
			["1", "2", "3", "4", "5"],
		);
	});
});
