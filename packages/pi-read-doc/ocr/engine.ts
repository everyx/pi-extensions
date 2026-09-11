/**
 * pi-read-doc — the OCR engine seam.
 *
 * One plugin point, narrow on purpose: page images in, per-page text out.
 * Rasterization (poppler) is shared by every engine, so it stays outside;
 * PDF fetching, page budgets and assembly are the caller's. A second engine
 * is a new file implementing this interface — nothing else moves.
 *
 * Scope note: the seam takes images because that is the common denominator
 * (tesseract, PaddleOCR, EasyOCR, vision models all eat images). A PDF-native
 * engine (e.g. ocrmypdf) would need an `inputKind: "pdf"` capability bit and
 * a coordinator that skips rasterization — a small widening, not a rewrite.
 */

/** Why an OCR run produced nothing the chain can use. */
export type OcrFailure =
	/** The engine (or its Python/CLI runtime) is not installed here. */
	| "engine-missing"
	/** The run exceeded its budget. */
	| "timeout"
	/** The engine ran but failed (crash, unreadable output, …). */
	| "failed";

export interface OcrPage {
	/** Recognized text — "" when the image carried no text (a photo page). */
	text: string;
	/** Lines the confidence floor rejected. Reported so callers can tell "the
	 *  image has no text" from "the text we read was too faint to trust". */
	droppedLines?: number;
	/** Set when this page could not be read at all (engine error, or the run
	 *  ended before reaching it). Distinct from an empty page. */
	error?: string;
}

export interface OcrRunOk {
	ok: true;
	/** Per-image result, 1:1 and in the order the images were passed. */
	pages: OcrPage[];
}

export interface OcrRunErr {
	ok: false;
	reason: OcrFailure;
	/** Raw detail for diagnostics (never the user-facing hint). */
	detail?: string;
}

export interface OcrEngine {
	/** Usable on this machine? Probed once and cached by the adapter. Takes the
	 *  caller's budget so a wedged probe cannot outlive the read's deadline. */
	available(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;
	/** Recognize each image, 1:1 and in order. */
	recognize(images: string[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OcrRunOk | OcrRunErr>;
	/** What the user must install to make this engine work (UI-only text). */
	installHint(): string;
}
