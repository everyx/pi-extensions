/**
 * pi-read-doc — local recovery of a PDF anydoc refused.
 *
 * The coordinator the engine seam was designed around: probe the flagged
 * pages, plan the routes (pdf/plan.ts), convert the text runs with anydoc,
 * OCR the image-only pages, and hand back the document as blocks in page
 * order. Every external tool arrives through a dep, so the whole flow runs
 * against fakes in tests.
 *
 * **Time is the budget, pages are not.** A scanned page costs ~2-3s, but a
 * page's cost varies with how much text it carries, so the knob is wall clock
 * (`budgetMs`) and it covers the whole recovery — probes, splitting, rendering
 * and OCR alike. The OCR subprocess is killed at the deadline, and every step
 * boundary re-checks it.
 *
 * OCR runs in batches so page images are rendered just before they are read:
 * a 600-page book cannot fill the temp dir with images nobody will look at.
 *
 * Honesty rules baked in here:
 *   - a page whose OCR yields no real text becomes a `note`, never a silent gap;
 *   - pages the budget or an abort cut short are reported the same way;
 *   - a missing tool is a failure with a reason, not an empty document.
 */

import { randomBytes } from "node:crypto";
import type { OcrEngine, OcrPage } from "../ocr/engine.js";
import { planPages } from "./plan.js";
import { type PdfTools, resolveDpi } from "./poppler.js";

/** One slice of the recovered document, in page order. */
export interface RecoveredBlock {
	/** Pages this block covers (1-based, ascending). */
	pages: number[];
	text: string;
	/** Source page image — only on pages whose text came from OCR. */
	image?: string;
	/** Anything the reader should know: that the text was machine-read, that a
	 *  page held no text, why a page is missing. Natural language, and it
	 *  accompanies text rather than replacing it. */
	note?: string;
}

export type Recovery =
	| {
			ok: true;
			blocks: RecoveredBlock[];
			/** A diagnostic worth showing the user (the engine's stderr when a run
			 *  failed): the read still succeeded, so this rides the result. */
			hint?: string;
	  }
	| {
			ok: false;
			reason: "poppler-missing" | "engine-missing" | "failed" | "cancelled";
			/** What the user can do about it — the ENGINE's own guidance when the
			 *  engine is the thing missing, so adding a second engine really does
			 *  not touch any other file. */
			hint?: string;
	  };

/** Rasterization for the OCR engine: 200 DPI reads text well; 2200px caps a
 *  mis-declared page box (see pdf/poppler.ts resolveDpi). */
export const OCR_RENDER = { dpi: 200, maxPx: 2200, format: "png" } as const;
/** Rasterization for the copy the MODEL reads: 150 DPI is legible, and a 1500px
 *  long side lands near what the model itself processes (~2300 tokens against
 *  ~4100 for a 2200px page) — no pixel is paid for twice. */
export const VIEW_RENDER = { dpi: 150, maxPx: 1500, format: "jpeg" } as const;

/**
 * A note says only what the reader cannot see for itself. "This came from OCR"
 * repeats the block's own shape (its `image` field is right there), and "OCR
 * may misread" is the reader's prior, not a fact we hold — both are paid for on
 * every read and change nothing. What IS ours to say: why a block has no text,
 * since nothing else in the reply explains it.
 */
const NOTE_NO_TEXT = "no text found in the page image";
/** The image HAS text, but every line fell under the confidence floor — a
 *  different fact from "there was nothing to read", and worth saying. */
const NOTE_FAINT_TEXT = "only low-confidence text in the page image";

/**
 * Collapse entries that share a note into one page list — used both for the
 * pages a run never reached and for the blocks the reply had no room for.
 * Order inside a list is page order; callers sort the blocks themselves.
 */
function groupPagesByNote(entries: { pages: number[]; note: string }[]): Map<string, number[]> {
	const byNote = new Map<string, number[]>();
	for (const { pages, note } of entries) byNote.set(note, [...(byNote.get(note) ?? []), ...pages]);
	return byNote;
}

/** Wall-clock budget for one recovery. ~2-3s per scanned page measured, so
 *  this covers a couple of dozen pages; the user-facing knob. */
export const DEFAULT_BUDGET_MS = 120_000;

/** Pages rendered per OCR call: bounds the images on disk and amortizes the
 *  engine's model load (~0.8s) over several pages. */
export const OCR_BATCH = 5;

export interface RecoveryDeps {
	pdf: PdfTools;
	engine: OcrEngine;
	/** Where the recovery is, for a UI that can show it: a scanned page costs
	 *  seconds, so a silent card looks hung. Never fails the read. */
	onProgress?: (note: string) => void;
	/** anydoc on a sub-PDF → markdown. Injected: recovery imports no engine.
	 *  It takes the step budget so one stuck conversion cannot outlive the read
	 *  (anydoc itself is not cancellable, but this promise is). */
	convertSubset: (subPdfPath: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
	/** `scratch` holds the intermediate single-page PDFs (removed by the
	 *  caller); `artifacts` holds the page images (kept for the session). */
	dirs: { scratch: string; artifacts: string };
	/** Wall clock for the whole recovery (default DEFAULT_BUDGET_MS). */
	budgetMs?: number;
	signal?: AbortSignal;
}

export async function recoverPdf(
	pdfPath: string,
	flagged: readonly number[],
	pageCount: number,
	deps: RecoveryDeps,
): Promise<Recovery> {
	const deadline = Date.now() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
	/** Renders are namespaced per recovery: the artifacts directory outlives us
	 *  (keyed by path, kept for the session), so a re-read of a re-written file
	 *  would collide with the previous read's page images. */
	const tag = randomBytes(4).toString("hex");
	const remaining = () => deadline - Date.now();
	/** Each step gets what is left, never its own unrelated cap: a 30s budget
	 *  must not be blown by a two-minute pdfseparate. */
	const stepBudget = () => ({
		timeoutMs: Math.max(1, remaining()),
		...(deps.signal ? { signal: deps.signal } : {}),
	});
	/** Cancelled is a failure — the caller asked to stop, and the SPEC forbids
	 *  handing half a result back as a finished read. Only a spent budget is the
	 *  partial result. */
	const stopFailure = (why: "cancelled" | "budget"): Recovery | null =>
		why === "cancelled" ? { ok: false, reason: "cancelled" } : null;
	const aborted = () => deps.signal?.aborted === true;
	/** Why we must stop now: an abort beats an expired budget. */
	const stop = (): "cancelled" | "budget" | null => (aborted() ? "cancelled" : remaining() <= 0 ? "budget" : null);

	/** The one way we build a cancellation: a step that failed BECAUSE the read
	 *  was aborted is not a missing tool or a broken document. */
	const abortedFailure = (): Recovery | null => (aborted() ? stopFailure("cancelled") : null);

	const blocks: RecoveredBlock[] = [];
	const notRead: { pages: number[]; note: string }[] = [];
	/** A failed OCR run's own diagnostics, surfaced to the user (not the model). */
	let ocrHint: string | undefined;
	/** The note for a stop reason, or null when we did not stop. */
	const reasonNote = (why: "cancelled" | "budget" | null): string | null =>
		why === "cancelled" ? "not read: cancelled" : why === "budget" ? "not read: time budget" : null;
	/** Everything still unread becomes a labelled gap: the spent-budget path. */
	const gapOut = (runs: readonly number[][], why: "cancelled" | "budget") => {
		for (const run of runs) notRead.push({ pages: [...run], note: reasonNote(why) as string });
	};

	if (!(await deps.pdf.available(stepBudget()))) {
		// Same rule as the engine probe below: a probe that ran out of budget
		// says nothing about whether poppler is installed. A spent budget is a
		// partial result — so every page comes back as a gap, not as a failure
		// telling the user to install what they already have.
		const why = stop();
		if (why) {
			const fail = stopFailure(why);
			if (fail) return fail;
			const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
			return { ok: true, blocks: [{ pages, text: "", note: reasonNote(why) as string }] };
		}
		return abortedFailure() ?? { ok: false, reason: "poppler-missing" };
	}

	// anydoc's list is a hint: pages it flagged may still carry a text layer
	// (reproduced). ONE call answers for every page (pdftotext separates pages
	// with a form feed) — probing page by page re-parses the whole PDF each
	// time and spends the budget before any OCR happens.
	const layer = await deps.pdf.pageTexts(pdfPath, stepBudget());
	if (stop() === "cancelled") return { ok: false, reason: "cancelled" };
	const withTextLayer = layer ? flagged.filter((p) => (layer[p - 1] ?? "").length > 0) : [];

	const plan = planPages({ pageCount, flagged, withTextLayer });
	// Physical page sizes decide each page's DPI — fetched once, for the document.
	const boxes = await deps.pdf.pageSizes(pdfPath, pageCount, stepBudget());

	// The engine is only required when there is actually something to OCR.

	/** anydoc has no timeout of its own, so this bounds OUR wait for it: the
	 *  promise settles at the budget even if the conversion never does. */
	function convertSubsetWithinBudget(subPdf: string): Promise<string> {
		const { timeoutMs, signal } = stepBudget();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("conversion exceeded the read budget")), timeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				reject(new Error("cancelled"));
			};
			const done = (fn: () => void) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			deps.convertSubset(subPdf, { timeoutMs, signal }).then(
				(text) => done(() => resolve(text)),
				(err) => done(() => reject(err)),
			);
		});
	}

	const ocrPages = [...plan.ocrPages];
	if (ocrPages.length > 0) deps.onProgress?.(`local OCR: ${ocrPages.length} of ${pageCount} pages`);
	if (ocrPages.length > 0 && !(await deps.engine.available(stepBudget()))) {
		// "I could not ask in time" is not "the engine is missing": telling the
		// user to install what they have would be a lie, and the SPEC promises
		// a spent budget is a partial result, not a failure.
		const why = stop();
		if (why) {
			const fail = stopFailure(why);
			if (fail) return fail;
			gapOut(
				ocrPages.map((page) => [page]),
				why,
			);
			ocrPages.length = 0;
		} else {
			return abortedFailure() ?? { ok: false, reason: "engine-missing", hint: deps.engine.installHint() };
		}
	}

	// ── Text runs: one anydoc call per contiguous run (markdown survives) ──
	const textRuns = [...plan.textRuns];
	if (textRuns.length > 0) {
		const pageFiles = stop() ? [] : await deps.pdf.separate(pdfPath, pageCount, deps.dirs.scratch, stepBudget());
		// Both a spent budget and a killed pdfseparate leave runs unread: that is a
		// gap note, not a broken tool (only a clean run with no pages is a failure).
		const killed = stop();
		if (killed) {
			const fail = stopFailure(killed);
			if (fail) return fail;
			gapOut(textRuns, killed);
			textRuns.length = 0;
		} else if (pageFiles.length === 0) {
			return abortedFailure() ?? { ok: false, reason: "failed", hint: "pdfseparate produced no pages" };
		}
		for (const [i, run] of textRuns.entries()) {
			deps.onProgress?.(`reading text pages (${i + 1}/${textRuns.length})`);
			const subPdf = `${deps.dirs.scratch}/run-${i}.pdf`;
			try {
				await deps.pdf.unite(
					run.map((p) => pageFiles[p - 1] as string),
					subPdf,
					stepBudget(),
				);
				blocks.push({ pages: run, text: await convertSubsetWithinBudget(subPdf) });
			} catch (err) {
				if (aborted()) return { ok: false, reason: "cancelled" };
				// One run failing must not cost the whole document: the gap is
				// labelled like every other gap (detail stays in the note).
				const detail = err instanceof Error ? err.message : String(err);
				blocks.push({ pages: run, text: "", note: `not read: conversion failed (${detail.slice(0, 80)})` });
			}
		}
	}

	// ── OCR pages: render a batch, read it, repeat (bounded disk + budget) ──
	for (let start = 0; start < ocrPages.length; start += OCR_BATCH) {
		const why = stop();
		if (why) {
			const fail = stopFailure(why);
			if (fail) return fail;
			notRead.push({ pages: ocrPages.slice(start), note: reasonNote(why) as string });
			break;
		}
		const batch = ocrPages.slice(start, start + OCR_BATCH);
		deps.onProgress?.(`local OCR: page ${batch[0]} of ${pageCount}\u2026`);
		const rendered: { page: number; image: string; view?: string }[] = [];
		const unrendered: number[] = [];
		for (const page of batch) {
			if (stop()) {
				unrendered.push(page);
				continue;
			}
			const box = boxes[page - 1];
			const image = await deps.pdf.render(pdfPath, page, deps.dirs.scratch, {
				...OCR_RENDER,
				tag,
				...stepBudget(),
				dpi: resolveDpi(box, OCR_RENDER.dpi, OCR_RENDER.maxPx),
			});
			if (!image) {
				unrendered.push(page);
				continue;
			}
			// The model reads a separate, smaller render: the OCR input is not
			// what a reader should be billed for.
			const view = await deps.pdf.render(pdfPath, page, deps.dirs.artifacts, {
				...VIEW_RENDER,
				tag,
				...stepBudget(),
				dpi: resolveDpi(box, VIEW_RENDER.dpi, VIEW_RENDER.maxPx),
			});
			rendered.push({ page, image, ...(view ? { view } : {}) });
		}

		if (rendered.length > 0) {
			const run = await deps.engine.recognize(
				rendered.map((r) => r.image),
				stepBudget(),
			);
			if (aborted()) return { ok: false, reason: "cancelled" };
			if (!run.ok) {
				if (run.reason === "engine-missing") return { ok: false, reason: "engine-missing" };
				// A run that produced nothing usable: the pages stay failed, the
				// reason rides each note, and the engine's stderr goes to the user
				// — "not read: failed" alone leaves nothing to act on.
				ocrHint = run.detail ? `local OCR failed: ${run.detail}` : `local OCR failed: ${run.reason}`;
				for (const r of rendered) notRead.push({ pages: [r.page], note: `not read: ${run.reason}` });
			} else {
				for (const [i, r] of rendered.entries()) {
					const result: OcrPage = run.pages[i] ?? { text: "", error: "not read" };
					const image = r.view ? { image: r.view } : {};
					if (result.error) {
						blocks.push({ pages: [r.page], text: "", ...image, note: `not read: ${result.error}` });
						continue;
					}
					// Whatever the engine read goes into `text`: no threshold may
					// rewrite a read into "nothing" — and a read needs no note, only
					// an empty block does.
					const text = result.text.trim();
					const note = text
						? undefined
						: (result.droppedLines ?? 0) > 0
							? `${NOTE_FAINT_TEXT} (${result.droppedLines} lines)`
							: NOTE_NO_TEXT;
					blocks.push({ pages: [r.page], text, ...image, ...(note ? { note } : {}) });
				}
			}
		}
		if (unrendered.length > 0) {
			notRead.push({ pages: unrendered, note: reasonNote(stop()) ?? "not read: page could not be rendered" });
		}
	}

	if (notRead.length > 0) {
		// One block per reason, pages listed — the model sees exactly what is
		// missing and why, in page order.
		for (const [note, pages] of groupPagesByNote(notRead)) {
			blocks.push({ pages: pages.sort((a, b) => a - b), text: "", note });
		}
	}

	// An abort that landed while there was still work to do is a cancellation,
	// not a document: the caller asked to stop, so we do not hand back a
	// half-read result as if it were the whole thing.
	if (aborted()) return { ok: false, reason: "cancelled" };
	return {
		ok: true,
		blocks: blocks.sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0)),
		...(ocrHint ? { hint: ocrHint } : {}),
	};
}
