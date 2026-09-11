/**
 * pi-read-doc — page plan for local recovery.
 *
 * When anydoc rejects a PDF with `needsOcr`, we recover the document locally.
 * This module decides, per page, which route its text takes. It is the only
 * branching logic in the recovery chain — so it lives alone, takes no I/O,
 * and is driven by a table of cases in the tests.
 *
 * It does NOT bound the work: how long the recovery may take is a wall-clock
 * budget (recover.ts), because a page's cost varies with how much text it
 * carries. A page count cannot express "how long may this take", and capping
 * pages would truncate a document whose pages happen to be cheap.
 *
 * The decision needs two facts:
 *   - anydoc's flagged pages: a HINT, not ground truth (it also flags pages
 *     that have a perfectly good text layer — reproduced against both a
 *     Poppler-readable PDF and a text-plus-figure page);
 *   - the pdftotext probe: which flagged pages actually carry text.
 */

export interface PagePlan {
	/** Contiguous runs of text-layer pages (1-based, ascending). Each run is
	 *  converted by anydoc — a run, not a page, so markdown survives. */
	textRuns: number[][];
	/** Pages to read with OCR, in page order. */
	ocrPages: number[];
}

export function planPages(opts: {
	/** Total pages in the document. */
	pageCount: number;
	/** 1-based pages anydoc flagged as needing OCR. */
	flagged: readonly number[];
	/** Flagged pages that turned out to have a text layer (false positives). */
	withTextLayer: readonly number[];
}): PagePlan {
	const hasText = new Set(opts.withTextLayer);
	const needsOcr = [...opts.flagged].filter((p) => !hasText.has(p)).sort((a, b) => a - b);
	const ocrSet = new Set(needsOcr);

	// The complement of the OCR pages, as contiguous runs — anydoc converts a
	// run at a time, so the page ranges stay accurate without per-page calls.
	const textRuns: number[][] = [];
	for (let page = 1; page <= opts.pageCount; page++) {
		if (ocrSet.has(page)) continue;
		const run = textRuns[textRuns.length - 1];
		if (run && run[run.length - 1] === page - 1) run.push(page);
		else textRuns.push([page]);
	}

	return { textRuns, ocrPages: needsOcr };
}
