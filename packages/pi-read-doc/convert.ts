/**
 * pi-read-doc — the conversion contract and the walk that follows it.
 *
 * A document is first handed to the parser (anydoc, local, whole-document). If
 * it comes back as `needsOcr`, the walk asks each configured engine in order
 * until one serves it, then hands back the page blocks.
 *
 * The engine knows nothing but this file: it gets a context and returns a
 * result, so the walk can be driven by fakes and no engine can reach into it.
 * `asNeedsOcr` is the only place anydoc's error shape appears.
 *
 * The two things that are NOT the walk have their own homes: page labels
 * (`page-labels.ts`) and the payload type (`ocr/recovered-block.ts`).
 */

import type { RecoveredBlock } from "./ocr/recovered-block.js";

// ── The contract ──────────────────────────────────────────────

/** The names `PI_READ_DOC_OCR_ENGINE` accepts. Adding one means adding a file
 *  in ocr/engines/ and a factory in its registry. */
export const ENGINE_IDS = ["firecrawl", "rapidocr"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface ServeContext {
	path: string;
	/** Lower-case extension, so an engine can say "not my job" (rapidocr is
	 *  PDF-only). */
	ext: string;
	/** Pages the parser flagged as scanned/image-only (1-based). */
	pages: readonly number[];
	/** Pages in the document. */
	pageCount: number;
	now: Date;
	signal?: AbortSignal;
	onProgress?: (note: string) => void;
}

export type ServeResult =
	/** Served: the document's blocks, in page order. */
	| { ok: true; blocks: RecoveredBlock[]; hint?: string }
	/** The user stopped the read: the walk stops too, this is not a failure. */
	| { ok: false; cancelled: true }
	/** Not this engine's kind of document — the walk moves on without noise. */
	| { ok: false; notApplicable: true }
	/** Tried and did not deliver. A `hint` only when the user can act on it. */
	| { ok: false; hint?: string };

export interface Engine {
	readonly id: EngineId;
	serve(ctx: ServeContext): Promise<ServeResult>;
}

/** Join user-facing notes: drop empties, dedupe, separate with " · ". Shared by
 *  the walk and the engines so one rule governs every hint on the card. */
export function joinHints(parts: readonly (string | undefined)[]): string {
	return [...new Set(parts.filter((p): p is string => Boolean(p)))].join(" · ");
}

/** Two shapes, one rule: everything the parser converts locally is markdown; a
 *  document it refused (needsOcr) comes back as page blocks. */
export type ConvertedDocument = (
	| { kind: "markdown"; text: string; via: "anydoc" }
	| { kind: "blocks"; blocks: RecoveredBlock[]; via: EngineId }
) & {
	/** A short, user-facing note about HOW this conversion happened (a parked
	 *  gate, a rejected key, which engine ran). UI only — the model gets the
	 *  blocks and their notes, not this. */
	hint?: string;
};

/** What a failed conversion tells its caller. This is the one definition — the
 *  error we throw, the tool that reads it and the tests all share it. */
export interface ConversionFailure {
	/** The parser's own code, when the parser is what failed. */
	code?: string;
	/** The user stopped it (the card shows the stop state, not a ✗). */
	cancelled?: true;
	/** We reached `needsOcr` with a usable page count: OCR is really what was
	 *  needed, so the configuration is worth explaining. */
	ocrNeeded?: true;
	/** What each engine that failed had to say (already user-facing). */
	engineHints?: string[];
	/** The legal `PI_READ_DOC_OCR_ENGINE` values, when the config is invalid. */
	configLegal?: string;
}

export interface WalkDeps {
	/** The parser: anydoc, local, whole document or nothing. */
	parse: (path: string) => Promise<string>;
	/** Engines in the order the configuration asked for (see the registry). */
	engines: readonly Engine[];
}

// ── The walk ──────────────────────────────────────────────────

/** The extension of anydoc's rejection for a document that needs OCR. Only
 *  this file knows that shape; engines deal in `RecoveredBlock`. */
export function asNeedsOcr(err: unknown): { pages: number[]; pageCount: number } | null {
	const e = err as { code?: string; pages?: number[]; pageCount?: number } | null;
	if (e?.code !== "needsOcr") return null;
	return { pages: e.pages ?? [], pageCount: e.pageCount ?? 0 };
}

/** The user stopped the read: one sentence on both layers, and the card shows
 *  the stop state rather than a ✗ that reads like a broken document. */
function cancelledError(): Error {
	return Object.assign(new Error("read cancelled"), { cancelled: true as const });
}

/** The config is unusable. Reported only once we know OCR is actually needed —
 *  the same document converts fine without it. */
function withConfigInvalid(err: unknown, info: { legal: string }): Error {
	const e = err instanceof Error ? err : new Error(String(err));
	return Object.assign(e, { ocrNeeded: true as const, configLegal: info.legal });
}

/** Attach every engine's own reason to the propagated error, keeping the
 *  original `code` (the tool branches on it) and noting that engines were tried. */
function withEngineHints(err: unknown, hints: string[], notApplicable: number, total: number): Error {
	const e = err instanceof Error ? err : new Error(String(err));
	// Only when EVERY engine said "not my kind of document": otherwise the
	// format is not the reason, and blaming it would point the user the wrong way.
	const formatNote =
		total > 0 && notApplicable === total ? "no configured OCR engine can read this kind of document" : undefined;
	// One entry per engine (its own hints are already merged): no round-trip
	// through the separator, which would split a hint that itself used " · ".
	const notes = [...new Set([...hints, ...(formatNote ? [formatNote] : [])])];
	return Object.assign(e, { ocrNeeded: true as const, ...(notes.length ? { engineHints: notes } : {}) });
}

export async function convertDocument(
	path: string,
	ext: string,
	deps: WalkDeps,
	opts: {
		signal?: AbortSignal;
		now?: Date;
		onProgress?: (note: string) => void;
		configInvalid?: { legal: string };
	} = {},
): Promise<ConvertedDocument> {
	try {
		// The parser converts the whole document or nothing: one scanned page
		// makes it reject everything, text pages included (verified).
		return { kind: "markdown", text: await deps.parse(path), via: "anydoc" };
	} catch (err) {
		const needs = asNeedsOcr(err);
		if (!needs) throw err;
		// Configuration errors are about the document being unreadable, not about
		// the page count: report them before any engine-shaped reasoning.
		if (opts.configInvalid) throw withConfigInvalid(err, opts.configInvalid);
		// Without a page count nothing an engine returns can be attributed, and a
		// block with an empty `pages` would contradict the shape we promise.
		if (needs.pageCount <= 0) throw err;

		const shared = {
			now: opts.now ?? new Date(),
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
		};
		const hints: string[] = [];
		let notApplicable = 0;

		for (const engine of deps.engines) {
			// Esc means stop: never start the next engine, let alone upload after
			// the user asked us to stop.
			if (opts.signal?.aborted) throw cancelledError();
			const out = await engine.serve({ path, ext, pages: needs.pages, pageCount: needs.pageCount, ...shared });
			if (out.ok) {
				const hint = joinHints([...hints, out.hint]);
				return {
					kind: "blocks",
					blocks: out.blocks,
					via: engine.id,
					...(hint ? { hint } : {}),
				};
			}
			if ("cancelled" in out) throw cancelledError();
			if ("notApplicable" in out) notApplicable++;
			else if (out.hint) hints.push(out.hint);
		}

		throw withEngineHints(err, hints, notApplicable, deps.engines.length);
	}
}
