import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPdfTools, parsePageSizes, resolveDpi } from "../pdf/poppler.js";
import type { RunCli } from "../run.js";
import { fakeRun } from "./helpers.js";

const tools = (opts: { run?: RunCli; files?: string[] } = {}) =>
	createPdfTools({
		run: opts.run ?? fakeRun().run,
		listDir: async () => opts.files ?? [],
	});

const render = (o: { format?: "png" | "jpeg"; tag?: string } = {}) => ({
	dpi: 200,
	maxPx: 2200,
	format: o.format ?? ("png" as const),
	...(o.tag ? { tag: o.tag } : {}),
});

describe("resolveDpi — 目标 DPI + 像素上限", () => {
	const letter = { w: 612, h: 792 };

	it("标准页取满目标 DPI（letter @200dpi 恰好 2200px 长边）", () => {
		assert.equal(resolveDpi(letter, 200, 2200), 200);
	});

	it("小页不被放大超过目标 DPI（名片不会被拉到 440dpi）", () => {
		assert.equal(resolveDpi({ w: 216, h: 360 }, 200, 2200), 200);
	});

	it("畸形页框（像素当点）被上限压回去，不爆像素", () => {
		assert.equal(resolveDpi({ w: 1700, h: 2200 }, 200, 2200), 72);
	});

	it("比 letter 稍高的页略降 DPI，仍在上限内", () => {
		// A4: 2200*72/842 = 188
		assert.equal(resolveDpi({ w: 595, h: 842 }, 200, 2200), 188);
	});

	it("页框未知时退回目标 DPI（不猜）", () => {
		assert.equal(resolveDpi(undefined, 200, 2200), 200);
		assert.equal(resolveDpi({ w: 0, h: 0 }, 200, 2200), 200);
	});

	it("永不返回 0（退化页框也给出可用的最小密度）", () => {
		assert.ok(resolveDpi({ w: 100000, h: 100000 }, 200, 2200) >= 1);
	});
});

describe("parsePageSizes", () => {
	it("按页号解析 pdfinfo 输出", () => {
		const out = [
			"Producer:        cairo 1.18.0",
			"Page    1 size:  612 x 792 pts (letter)",
			"Page    2 size:  595.276 x 841.89 pts (A4)",
		].join("\n");
		assert.deepEqual(parsePageSizes(out), [
			{ w: 612, h: 792 },
			{ w: 595.276, h: 841.89 },
		]);
	});

	it("乱序也按页号排好；垃圾行忽略", () => {
		const out = "Page    2 size:  10 x 20 pts\nnoise\nPage    1 size:  30 x 40 pts";
		assert.deepEqual(parsePageSizes(out), [
			{ w: 30, h: 40 },
			{ w: 10, h: 20 },
		]);
	});

	it("pdfinfo 漏报某页 → 那一格是空洞，后面的页不会挪位", () => {
		// 按页号占位而不是顺序追加：漏一行（`pdfinfo` 偶发/畸形页框）时，
		// 顺序追加会把第 3 页的页框安到第 2 页头上，于是 DPI 悄悄算错。
		const out = "Page    1 size:  612 x 792 pts\nPage    3 size:  10 x 20 pts";
		const sizes = parsePageSizes(out);
		assert.deepEqual(sizes[0], { w: 612, h: 792 });
		assert.equal(sizes[1], undefined, "第 2 页没有页框 → 空洞，交回退（目标 DPI）");
		assert.deepEqual(sizes[2], { w: 10, h: 20 }, "第 3 页仍是第 3 页");
	});

	it("无匹配 → 空数组", () => {
		assert.deepEqual(parsePageSizes("Page size: 612 x 792 pts (letter)"), [], "单页样式（无 -f/-l）不算");
	});
});

describe("poppler adapter", () => {
	it("available: probes all five tools once, then caches", async () => {
		const { run, calls } = fakeRun();
		const t = tools({ run });
		assert.equal(await t.available(), true);
		assert.equal(await t.available(), true);
		assert.deepEqual(
			calls.map((c) => c.cmd),
			["pdftotext", "pdftoppm", "pdfseparate", "pdfunite", "pdfinfo"],
			"five probes, no repeats",
		);
	});

	it("available: a missing binary (ENOENT) is unavailable — no throw", async () => {
		const { run } = fakeRun((cmd) => (cmd === "pdftoppm" ? { code: null, stderr: "spawn pdftoppm ENOENT" } : {}));
		assert.equal(await tools({ run }).available(), false);
	});

	it("pageTexts: ONE call for every page, split on the form feed", async () => {
		const { run, calls } = fakeRun(() => ({ stdout: "page one\f\fpage three\f" }));
		const pages = await tools({ run }).pageTexts("/x.pdf");
		assert.deepEqual(pages, ["page one", "", "page three"], "index = page - 1, empty page stays empty");
		assert.deepEqual(calls[0]?.args, ["-q", "/x.pdf", "-"], "one process, not one per page");
		assert.equal(calls.length, 1);
	});

	it("pageTexts: failure is null (the caller treats it as no text anywhere)", async () => {
		const { run } = fakeRun(() => ({ code: null, stderr: "spawn pdftotext ENOENT" }));
		assert.equal(await tools({ run }).pageTexts("/x.pdf"), null);
	});

	it("pageSizes: asks for the pages we know about, in one call", async () => {
		const { run, calls } = fakeRun(() => ({ stdout: "Page    1 size:  612 x 792 pts (letter)" }));
		const sizes = await tools({ run }).pageSizes("/x.pdf", 3);
		assert.deepEqual(sizes, [{ w: 612, h: 792 }]);
		assert.deepEqual(calls[0]?.args, ["-f", "1", "-l", "3", "/x.pdf"]);
	});

	it("pageSizes: unavailable tool → empty (the caller falls back to the target DPI)", async () => {
		const { run } = fakeRun(() => ({ code: null, stderr: "ENOENT" }));
		assert.deepEqual(await tools({ run }).pageSizes("/x.pdf", 2), []);
		assert.deepEqual(await tools({ run }).pageSizes("/x.pdf", 0), [], "no pages, no call");
	});

	it("separate: deterministic page paths, one per page", async () => {
		const { run, calls } = fakeRun();
		const files = await tools({ run }).separate("/x.pdf", 3, "/tmp/d");
		assert.deepEqual(files, ["/tmp/d/p-1.pdf", "/tmp/d/p-2.pdf", "/tmp/d/p-3.pdf"]);
		assert.deepEqual(calls[0]?.args, ["/x.pdf", "/tmp/d/p-%d.pdf"]);
	});

	it("separate: failure yields no files (the caller falls back)", async () => {
		const { run } = fakeRun(() => ({ code: 1 }));
		assert.deepEqual(await tools({ run }).separate("/x.pdf", 2, "/tmp/d"), []);
	});

	it("unite: preserves order and skips an empty selection", async () => {
		const { run, calls } = fakeRun();
		const t = tools({ run });
		await t.unite([], "/tmp/out.pdf");
		assert.equal(calls.length, 0, "nothing to merge — no call");
		await t.unite(["/tmp/p-2.pdf", "/tmp/p-1.pdf"], "/tmp/out.pdf");
		assert.deepEqual(calls[0]?.args, ["/tmp/p-2.pdf", "/tmp/p-1.pdf", "/tmp/out.pdf"]);
	});

	it("render: asks for the resolved density and takes poppler's own filename", async () => {
		const { run, calls } = fakeRun();
		const path = await tools({ run, files: ["page-003.png"] }).render("/x.pdf", 3, "/tmp/art", render());
		assert.equal(path, "/tmp/art/page-003.png");
		assert.deepEqual(calls[0]?.args.slice(0, 6), ["-f", "3", "-l", "3", "-r", "200"]);
		assert.ok(calls[0]?.args.includes("-png"));
	});

	it("render: jpeg for the model's copy, with a quality setting", async () => {
		const { run, calls } = fakeRun();
		const path = await tools({ run, files: ["page-1.jpg"] }).render(
			"/x.pdf",
			1,
			"/tmp/art",
			render({ format: "jpeg" }),
		);
		assert.equal(path, "/tmp/art/page-1.jpg", "matches the format's extension");
		assert.ok(calls[0]?.args.includes("-jpeg"));
		assert.ok(calls[0]?.args.includes("-jpegopt"));
	});

	it("render: no output for this page is a failure — not a guess", async () => {
		const { run } = fakeRun();
		assert.equal(await tools({ run, files: [] }).render("/x.pdf", 1, "/tmp/art", render()), null);
		assert.equal(
			await tools({ run, files: ["page-1.png", "page-2.png"] }).render("/x.pdf", 3, "/tmp/art", render()),
			null,
			"别的页的图不算这一页的",
		);
	});

	it("render: a shared directory keeps working page after page (regression)", async () => {
		// Scratch and artifacts accumulate every page's image; requiring "the
		// only file in the dir" meant page 2 onwards silently never rendered.
		const { run } = fakeRun();
		const t = tools({ run, files: ["page-1.png", "page-2.png", "page-3.png"] });
		assert.equal(await t.render("/x.pdf", 2, "/tmp/scratch", render()), "/tmp/scratch/page-2.png");
		assert.equal(await t.render("/x.pdf", 3, "/tmp/scratch", render()), "/tmp/scratch/page-3.png");
	});

	it("render: 同一路径二次读取（artifacts 留着上一份的页图）不会认错文件", async () => {
		// artifacts 按路径保留整个会话：重写过的文件再读一次时，上一份的
		// page-03.jpg 还在目录里，而新的一份叫 page-3.jpg —— 两个都匹配就等于
		// 认不出这一页，于是"渲染成功却没有图"。
		const { run } = fakeRun();
		const path = await tools({ run, files: ["page-03.jpg", "page-3.jpg", "page-abcd-3.jpg"] }).render(
			"/x.pdf",
			3,
			"/tmp/art",
			render({ format: "jpeg", tag: "abcd" }),
		);
		assert.equal(path, "/tmp/art/page-abcd-3.jpg", "认自己这一份，不碰上一份的残留");
	});

	it("render: poppler's zero padding follows the document page count", async () => {
		// Measured: page 3 of a 12-page document is page-03.png.
		const { run } = fakeRun();
		const path = await tools({ run, files: ["page-03.png", "page-12.png"] }).render("/x.pdf", 3, "/tmp/art", render());
		assert.equal(path, "/tmp/art/page-03.png");
	});
});

describe("poppler availability — probe caching", () => {
	it("超时/中止的探测不缓存（一次饿死的探测不能毒化整个会话）", async () => {
		const { run, calls } = fakeRun(() => ({ code: null, timedOut: true }));
		const t = tools({ run });
		assert.equal(await t.available({ timeoutMs: 1 }), false, "这次没有结论");
		const callsAfterFirst = calls.length;
		assert.equal(await t.available({ timeoutMs: 30_000 }), false);
		assert.ok(calls.length > callsAfterFirst, "必须重探，而不是复用被饿死的那次结论");
	});

	it("五个解释器都答了才是定论（可缓存）", async () => {
		const { run, calls } = fakeRun(() => ({ code: 0 }));
		const t = tools({ run });
		assert.equal(await t.available(), true);
		const probes = calls.length;
		assert.equal(await t.available(), true);
		assert.equal(calls.length, probes, "定论只探一次");
	});
});
