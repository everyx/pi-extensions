/**
 * End-to-end proof of the local recovery path against the REAL tools
 * (poppler + rapidocr). Opt-in, because it needs both installed:
 *
 *   PI_READ_DOC_TEST_LOCAL=1 pnpm --filter @everyx/pi-read-doc test
 *
 * The unit tests drive every decision with fakes; this one answers the
 * different question "does the pipeline actually read a scanned page".
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRapidOcr } from "../ocr/rapidocr.js";
import { createPdfTools } from "../pdf/poppler.js";
import { recoverPdf } from "../pdf/recover.js";
import { createRunCli } from "../run.js";

const enabled = process.env.PI_READ_DOC_TEST_LOCAL === "1";
const run = createRunCli();

/** Build a PDF that looks like a real scan: a letter-sized page (200 dpi
 *  resolution, not pixel-sized) with text at a document-plausible size —
 *  page geometry is what makes text detectable after rasterization. */
async function makeScanPdf(
	path: string,
	lines: string[],
	photoPage = false,
	extraPages: string[][] = [],
): Promise<boolean> {
	const script = [
		"from PIL import Image, ImageDraw, ImageFont",
		"import glob, random, sys",
		// A real outline font, not PIL's bitmap default, and more than one line:
		// the text detector needs realistic glyph weight and extent — a lone
		// short line is invisible to it (measured both ways), which would make
		// the fixture lie about what a scan looks like.
		"cands = (sorted(glob.glob('/usr/share/fonts/**/*Sans-Regular.ttf', recursive=True))",
		"         + sorted(glob.glob('/usr/share/fonts/**/*.ttf', recursive=True))",
		"         + glob.glob('/System/Library/Fonts/Supplemental/Arial.ttf')",
		"         + sorted(glob.glob('/Library/Fonts/*.ttf')))",
		"font = ImageFont.truetype(cands[0], 32) if cands else ImageFont.load_default()",
		"img = Image.new('L', (1700, 2200), 255)",
		"d = ImageDraw.Draw(img)",
		"for i, line in enumerate(" + JSON.stringify(lines) + "):",
		"    d.text((100, 150 + i * 110), line, fill=0, font=font)",
		"pages = [img]",
		"for extra in " + JSON.stringify(extraPages) + ":",
		"    more = Image.new('L', (1700, 2200), 255)",
		"    md = ImageDraw.Draw(more)",
		"    for i, line in enumerate(extra):",
		"        md.text((100, 150 + i * 110), line, fill=0, font=font)",
		"    pages.append(more)",
		"if " + (photoPage ? "True" : "False") + ":",
		"    noise = Image.new('L', (1700, 2200))",
		"    px = noise.load()",
		"    for y in range(0, 2200, 2):",
		"        for x in range(0, 1700, 2):",
		"            px[x, y] = random.randint(60, 200)",
		"    pages.append(noise)",
		"pages[0].save(sys.argv[1], save_all=True, append_images=pages[1:], resolution=200)",
	].join("\n");
	const res = await run("python3", ["-c", script, path], { timeoutMs: 120_000 });
	return res.code === 0;
}

describe("local recovery — real poppler + rapidocr", { skip: !enabled }, () => {
	let dir = "";
	const pdfTools = createPdfTools({ run });
	const engine = createRapidOcr({ run });

	/** The artifact dir must exist before rendering — production creates it
	 *  with mkdir; a missing one would silently degrade to a "not rendered"
	 *  note and make the assertions pass for the wrong reason. */
	const dirs = async (name: string) => {
		const artifacts = join(dir, `art-${name}`);
		const scratch = join(dir, `scratch-${name}`);
		await mkdir(artifacts, { recursive: true });
		await mkdir(scratch, { recursive: true });
		return { scratch, artifacts };
	};

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-read-doc-it-"));
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it("bridge: 「这页没文字」与「输出形状不认识」必须是两个答案", async () => {
		// 只有真跑 python 才能钉住它：把「引擎换了返回结构」报成「这页没有文字」
		// 是一句用户与模型都无法察觉的假话（第 15 轮走读发现）。
		const bridge = fileURLToPath(new URL("../ocr/rapidocr_bridge.py", import.meta.url));
		const script = [
			"import importlib.util, json, sys",
			"spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])",
			"bridge = importlib.util.module_from_spec(spec)",
			"spec.loader.exec_module(bridge)",
			"class NoText:",
			"    txts = None",
			"    scores = None",
			"print(json.dumps({",
			"    'empty_new_api': bridge.extract(NoText()),",
			"    'empty_old_api': bridge.extract([None, 0.5]),",
			"    'text_new_api': bridge.extract(type('T', (), {'txts': ['hi'], 'scores': [0.9]})()),",
			"    'unknown_shape': bridge.extract(object()),",
			"}))",
		].join("\n");
		const res = await run("python3", ["-c", script, bridge], { timeoutMs: 120_000 });
		assert.equal(res.code, 0, `bridge probe failed: ${res.stderr}`);
		const got = JSON.parse(res.stdout) as Record<string, unknown>;
		assert.deepEqual(got.empty_new_api, [[], []], "新 API 的空页 = 空文字，不是错误");
		assert.deepEqual(got.empty_old_api, [[], []], "旧 API 的空页同理");
		assert.deepEqual(got.text_new_api, [["hi"], [0.9]], "有字照旧");
		assert.equal(got.unknown_shape, null, "不认识的形状要能区分出来（bridge 会写成 error 行）");
	});

	it("reads a scanned page end-to-end and keeps its source image", async () => {
		const pdf = join(dir, "scan.pdf");
		assert.ok(await makeScanPdf(pdf, ["INVOICE PROBE 42", "Total 1234 EUR"]), "fixture built");

		const res = await recoverPdf(pdf, [1], 1, {
			pdf: pdfTools,
			engine,
			convertSubset: async () => {
				throw new Error("a pure scan has no text run");
			},
			dirs: await dirs("scan"),
		});

		assert.ok(res.ok, `recovery failed: ${JSON.stringify(res)}`);
		const block = res.blocks[0];
		assert.equal(block?.pages[0], 1);
		assert.match(block?.text ?? "", /PROBE\s*42/i, `OCR text was: ${JSON.stringify(block?.text)}`);
		assert.ok(block?.image, "the source page image is attached");
		// The artifact must survive the call — the model reads it later.
		assert.ok((await stat(block?.image as string)).size > 0, "page image exists on disk");
	});

	it("a text-free page becomes a labelled gap, never OCR noise", async () => {
		const pdf = join(dir, "photo.pdf");
		assert.ok(await makeScanPdf(pdf, ["REAL TEXT PAGE"], true), "fixture built");

		const res = await recoverPdf(pdf, [2], 2, {
			pdf: pdfTools,
			engine,
			convertSubset: async () => "markdown of the text page",
			dirs: await dirs("photo"),
		});

		assert.ok(res.ok, `recovery failed: ${JSON.stringify(res)}`);
		const photo = res.blocks.find((b) => b.pages[0] === 2);
		assert.equal(photo?.text, "", "no imagined content from a picture page");
		assert.match(photo?.note ?? "", /no text found|not read/);
		assert.ok(photo?.image, "the picture page is still viewable");
	});

	it("a page with a real text layer is never OCR'd, even when anydoc flags it", async (t) => {
		// A text-layer fixture needs a real PDF writer; ghostscript is the one
		// that is commonly present. Skip (not fail) where it is missing.
		const gs = await run("gs", ["-v"], { timeoutMs: 10_000 });
		if (gs.code !== 0) return t.skip("ghostscript not installed");

		const pdf = join(dir, "textlayer.pdf");
		const made = await run(
			"gs",
			[
				"-q",
				"-o",
				pdf,
				"-sDEVICE=pdfwrite",
				"-c",
				"/Helvetica findfont 24 scalefont setfont 72 700 moveto (REAL TEXT LAYER PAGE) show showpage",
			],
			{ timeoutMs: 60_000 },
		);
		assert.equal(made.code, 0, "fixture built");

		// Flagged [1] against a page that does carry a text layer: the cheap
		// probe must win, so no seconds of OCR are spent and no image is made.
		const d = await dirs("mixed");
		const res = await recoverPdf(pdf, [1], 1, {
			pdf: pdfTools,
			engine,
			convertSubset: async () => "markdown from the text layer",
			dirs: d,
		});
		assert.ok(res.ok, `recovery failed: ${JSON.stringify(res)}`);
		assert.equal(res.blocks[0]?.image, undefined, "no page image for a text-layer page");
		assert.equal(res.blocks[0]?.text, "markdown from the text layer");
	});

	it("真实链路：拆出文字页 → anydoc 出 markdown，扫描页 OCR（混合档）", async (t) => {
		const gs = await run("gs", ["-v"], { timeoutMs: 10_000 });
		if (gs.code !== 0) return t.skip("ghostscript not installed");

		// 页 1 是文字层（gs），页 2 是扫描件（PIL），合并成混合档 —— 正是
		// anydoc 会整体拒绝的那种输入。
		const textPdf = join(dir, "t.pdf");
		const scanPdf = join(dir, "s.pdf");
		const mixed = join(dir, "mixed-real.pdf");
		assert.equal(
			(
				await run(
					"gs",
					[
						"-q",
						"-o",
						textPdf,
						"-sDEVICE=pdfwrite",
						"-c",
						"/Helvetica findfont 24 scalefont setfont 72 700 moveto (CONTRACT CLAUSE SEVEN) show showpage",
					],
					{ timeoutMs: 60_000 },
				)
			).code,
			0,
		);
		assert.ok(await makeScanPdf(scanPdf, ["SIGNATURE PAGE PROBE"]), "fixture built");
		assert.equal((await run("pdfunite", [textPdf, scanPdf, mixed])).code, 0);

		// convertSubset 用真的 anydoc：这一步（pdfseparate → pdfunite → anydoc）
		// 之前只有手工验证过。
		const { toMarkdown } = await import("@firecrawl/anydoc");
		const d = await dirs("real");
		const res = await recoverPdf(mixed, [2], 2, {
			pdf: pdfTools,
			engine,
			convertSubset: async (sub) => toMarkdown(sub),
			dirs: d,
		});

		assert.ok(res.ok, `recovery failed: ${JSON.stringify(res)}`);
		const textBlock = res.blocks.find((b) => b.pages[0] === 1);
		assert.match(textBlock?.text ?? "", /CONTRACT CLAUSE SEVEN/, "文字页经 anydoc 子集转换后保住了内容");
		assert.equal(textBlock?.image, undefined, "文字页不产生页图");
		const ocrBlock = res.blocks.find((b) => b.pages[0] === 2);
		assert.match(ocrBlock?.text ?? "", /SIGNATURE/, "扫描页走 OCR");
		assert.ok(ocrBlock?.image, "并带上来源页图");
	});

	it("reads EVERY page of a multi-page scan (regression: only page 1 rendered)", async () => {
		const pdf = join(dir, "scan3.pdf");
		assert.ok(
			await makeScanPdf(pdf, ["PAGE ONE PROBE", "alpha line"], false, [
				["PAGE TWO PROBE", "bravo line"],
				["PAGE THREE PROBE", "charlie line"],
			]),
			"fixture built",
		);

		const res = await recoverPdf(pdf, [1, 2, 3], 3, {
			pdf: pdfTools,
			engine,
			convertSubset: async () => {
				throw new Error("a pure scan has no text run");
			},
			dirs: await dirs("multi"),
		});

		assert.ok(res.ok, `recovery failed: ${JSON.stringify(res)}`);
		// Every page gets its own text AND its own source image: a lenient
		// "the only file in the directory" check used to kill pages 2 and 3.
		// Each page must carry its OWN text: a shared/cached image would show up
		// as one page's words appearing on another.
		const markers = ["PAGE ONE", "PAGE TWO", "PAGE THREE"];
		const blocks = res.blocks;
		for (const n of [1, 2, 3]) {
			const found = blocks.filter((b) => b.pages.length === 1 && b.pages[0] === n);
			assert.equal(found.length, 1, `page ${n} produced exactly one block`);
			assert.match(found[0]?.text ?? "", new RegExp(markers[n - 1] as string), `page ${n} text`);
			assert.ok(found[0]?.image, `page ${n} kept its image`);
		}
	});

	it("reports a missing tool instead of throwing", async () => {
		const bare = createPdfTools({ run: async () => ({ code: null, stdout: "", stderr: "spawn pdftotext ENOENT" }) });
		const res = await recoverPdf("x.pdf", [1], 1, {
			pdf: bare,
			engine,
			convertSubset: async () => "",
			dirs: { scratch: dir, artifacts: dir },
		});
		assert.deepEqual(res, { ok: false, reason: "poppler-missing" });
	});
});
