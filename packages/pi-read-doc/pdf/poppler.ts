/**
 * pi-read-doc — poppler adapter (rasterize + text layer + page subsetting).
 *
 * Five CLI tools, one dependency (`poppler-utils`): `pdftotext` for the text
 * layer, `pdftoppm` to rasterize, `pdfseparate`/`pdfunite` to hand anydoc a
 * subset that holds only the pages it can convert, `pdfinfo` to learn a page's
 * physical size. Measured on a 100-page PDF: separate 0.09s, unite 0.03s —
 * splitting is free.
 *
 * Rasterization targets a DPI, capped by pixels (see resolveDpi): what OCR
 * needs is text HEIGHT in pixels — physical size × DPI — so a normalized pixel
 * size is the wrong rule. It renders small pages at 440 DPI (pixels nobody
 * asked for) and big ones at 47 (text too small to read).
 *
 * Thin on purpose: no chain logic here (that is pdf/plan.ts), no engine here
 * (that is ocr/engine.ts). Every call takes its paths from the caller, so the
 * temp-dir lifecycle stays in one place.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunCli, RunCliOptions } from "../run.js";

export const POPPLER_HINT =
	"Local OCR needs poppler (pdftotext/pdftoppm/pdfseparate/pdfunite/pdfinfo): apt install poppler-utils · brew install poppler · pacman -S poppler";

/** Per-call knobs the recovery passes down: what is left of its budget, and the
 *  abort signal — the same two the CLI runner itself takes. */
type StepOptions = Pick<RunCliOptions, "timeoutMs" | "signal">;

/** A page box in points (the page's declared physical size). */
export interface PageBox {
	w: number;
	h: number;
}

export interface RenderOptions {
	/** Target density: 200 reads text well, 150 is enough for a human/model. */
	dpi: number;
	/** Long-side ceiling in pixels — the guard against a mis-declared page box
	 *  (a scan whose page is 1700x2200 *points* would render 28.9 MP at 200
	 *  DPI; capped it renders 3.7 MP, six times faster, no less readable). */
	maxPx: number;
	format: "png" | "jpeg";
	/** Namespace for the output file. The artifacts directory is kept for the
	 *  session and keyed by path, so a second read of a re-written file at the
	 *  same path would otherwise still see the FIRST read's pages — and poppler
	 *  answering with both `page-03.jpg` and `page-3.jpg` looked like a failure. */
	tag?: string;
	/** Clamp for this call; the recovery passes what is left of its budget so
	 *  a single step cannot outlive the whole deadline. */
	timeoutMs?: number;
	/** Abort wiring — an aborted read must stop poppler too, not only OCR. */
	signal?: AbortSignal;
}

export interface PdfTools {
	/** All five tools present? Probed once, cached. */
	available(opts?: StepOptions): Promise<boolean>;
	/** Text layer for EVERY page in one call, indexed by page - 1 ("" when a
	 *  page has none). null = the tool failed, which the caller treats as "no
	 *  text anywhere" — the conservative default. One call, because each
	 *  per-page call re-parses the whole PDF: measured 65x slower on 100
	 *  pages, and it spends the recovery budget before any OCR happens. */
	pageTexts(pdfPath: string, opts?: StepOptions): Promise<string[] | null>;
	/** Declared page boxes, indexed by page - 1. [] when unavailable. */
	pageSizes(pdfPath: string, pageCount: number, opts?: StepOptions): Promise<PageBox[]>;
	/** Split into single-page PDFs; index i is page i+1. */
	separate(pdfPath: string, pageCount: number, dir: string, opts?: StepOptions): Promise<string[]>;
	/** Merge page PDFs into one (order preserved). */
	unite(files: string[], outPath: string, opts?: StepOptions): Promise<void>;
	/** Rasterize one page into `dir`; returns the produced image path. */
	render: (pdfPath: string, page: number, dir: string, opts: RenderOptions) => Promise<string | null>;
}

export interface PdfToolsDeps {
	run: RunCli;
	/** Test seam: directory listing (render finds poppler's own filename — its
	 *  zero-padding depends on the page count, so we never guess it). */
	listDir?: (dir: string) => Promise<string[]>;
}

/** A missing binary surfaces as spawn ENOENT → code null. */
function missing(res: { code: number | null; stderr: string }): boolean {
	return res.code === null && /ENOENT|not found/i.test(res.stderr);
}

/**
 * The DPI to render a page at: the target, never above the pixel ceiling.
 * A letter page gets the full 200 DPI (2200px long side is exactly 200 DPI);
 * a 3x5 card is not upscaled past it; a page whose box is pixel-sized — common
 * in scans — is capped instead of exploding.
 */
export function resolveDpi(box: PageBox | undefined, targetDpi: number, maxPx: number): number {
	const longSide = box ? Math.max(box.w, box.h) : 0;
	if (longSide <= 0) return targetDpi;
	return Math.max(1, Math.min(targetDpi, Math.round((maxPx * 72) / longSide)));
}

/** "Page    3 size:  612 x 792 pts (letter)" → { w: 612, h: 792 } */
export function parsePageSizes(stdout: string): PageBox[] {
	// Indexed BY PAGE NUMBER, not appended: a page pdfinfo did not report must
	// stay a hole (`undefined` → the caller falls back to the target DPI), or
	// every page after the gap would silently be given the wrong box.
	const sizes: PageBox[] = [];
	const lines = [...stdout.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)]
		.map((m) => ({ n: Number(m[1]), box: { w: Number(m[2]), h: Number(m[3]) } }))
		.filter((p) => p.n >= 1 && Number.isFinite(p.box.w) && Number.isFinite(p.box.h));
	for (const { n, box } of lines) sizes[n - 1] = box;
	return sizes;
}

const TOOLS = ["pdftotext", "pdftoppm", "pdfseparate", "pdfunite", "pdfinfo"];

export function createPdfTools(deps: PdfToolsDeps): PdfTools {
	const listDir = deps.listDir ?? ((dir: string) => readdir(dir));
	let probe: Promise<boolean> | undefined;

	/**
	 * The image poppler just wrote for this page.
	 *
	 * Its zero-padding follows the DOCUMENT's page count, not the rendered page
	 * — page 3 of a 12-page file lands in `page-03.png` (measured) — so the page
	 * number is matched with optional leading zeros. It must NOT be "the only
	 * file in the directory": scratch and artifacts accumulate images across a
	 * recovery, and requiring one file meant only the first page of a scanned
	 * document was ever rasterized.
	 */
	async function produced(dir: string, prefix: string, page: number, ext: string): Promise<string | null> {
		const pattern = new RegExp(`^${prefix}-0*${page}\\${ext}$`);
		const files = (await listDir(dir)).filter((f) => pattern.test(f));
		return files.length === 1 ? join(dir, files[0] as string) : null;
	}

	return {
		async available(opts: StepOptions = {}): Promise<boolean> {
			// One probe per process: `-v` exits 0 and proves the binary resolves.
			// It takes the step budget too — an unbounded, unabortable probe would
			// hang the whole read outside the deadline it promises.
			if (probe) return probe;
			// In parallel: five sequential probes could each burn the whole
			// remaining budget, and a wedged tool must not read as present —
			// a timeout is as inconclusive as an ENOENT.
			const results = await Promise.all(TOOLS.map((tool) => deps.run(tool, ["-v"], opts)));
			const ok = results.every((res) => res.code === 0 && !missing(res) && !res.timedOut);
			// Only a definitive answer is cached: a probe killed by the budget or
			// by Esc would otherwise poison every later read in this session.
			if (!ok && (results.some((res) => res.timedOut) || opts.signal?.aborted)) return false;
			probe = Promise.resolve(ok);
			return probe;
		},

		async pageTexts(pdfPath: string, opts: StepOptions = {}): Promise<string[] | null> {
			const res = await deps.run("pdftotext", ["-q", pdfPath, "-"], {
				timeoutMs: opts.timeoutMs ?? 60_000,
				signal: opts.signal,
			});
			if (missing(res) || res.code !== 0) return null;
			// pdftotext separates pages with a form feed; the trailing segment
			// after the last page is empty and dropped.
			const pages = res.stdout.split("\f");
			if (pages[pages.length - 1]?.trim() === "") pages.pop();
			return pages.map((p) => p.trim());
		},

		async pageSizes(pdfPath: string, pageCount: number, opts: StepOptions = {}): Promise<PageBox[]> {
			if (pageCount <= 0) return [];
			const res = await deps.run("pdfinfo", ["-f", "1", "-l", String(pageCount), pdfPath], {
				timeoutMs: opts.timeoutMs ?? 30_000,
				signal: opts.signal,
			});
			if (missing(res) || res.code !== 0) return [];
			return parsePageSizes(res.stdout);
		},

		async separate(pdfPath: string, pageCount: number, dir: string, opts: StepOptions = {}): Promise<string[]> {
			const prefix = join(dir, "p");
			const res = await deps.run("pdfseparate", [pdfPath, `${prefix}-%d.pdf`], {
				timeoutMs: opts.timeoutMs ?? 120_000,
				signal: opts.signal,
			});
			if (missing(res) || res.code !== 0) return [];
			// pdfseparate names pages by number with the literal %d — deterministic.
			return Array.from({ length: pageCount }, (_, i) => `${prefix}-${i + 1}.pdf`);
		},

		async unite(files: string[], outPath: string, opts: StepOptions = {}): Promise<void> {
			if (files.length === 0) return;
			await deps.run("pdfunite", [...files, outPath], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal });
		},

		async render(pdfPath, page, dir, opts): Promise<string | null> {
			const stem = opts.tag ? `page-${opts.tag}` : "page";
			const prefix = join(dir, stem);
			const kind = opts.format === "jpeg" ? ["-jpeg", "-jpegopt", "quality=85"] : ["-png"];
			const res = await deps.run(
				"pdftoppm",
				["-f", String(page), "-l", String(page), "-r", String(opts.dpi), ...kind, pdfPath, prefix],
				{ timeoutMs: opts.timeoutMs ?? 60_000, signal: opts.signal },
			);
			if (missing(res) || res.code !== 0) return null;
			return produced(dir, stem, page, opts.format === "jpeg" ? ".jpg" : ".png");
		},
	};
}
