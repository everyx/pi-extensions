/**
 * pi-read-doc — the conversion chain: anydoc local → hosted OCR → local
 * recovery.
 *
 * Behind an injected interface, so tests drive it with fakes — no engine, no
 * network, no filesystem. The two things that are NOT the chain have their own
 * homes: the hosted gate (`hosted-gate.ts`, a reaction to what the service
 * reported) and page labels (`page-labels.ts`, page numbers as text).
 */

import { type HostedGate, hostedExhaustion, hostedKeyRejected } from "./hosted-gate.js";
import { hostedNote } from "./page-labels.js";
import type { RecoveredBlock, Recovery } from "./pdf/recover.js";

/**
 * Two shapes, one rule: everything anydoc converts locally is markdown; a
 * document it refused (needsOcr) comes back as page blocks — from hosted OCR
 * or from local recovery.
 */
export type ConvertedDocument = (
	| { kind: "markdown"; text: string; via: "anydoc" }
	| { kind: "blocks"; blocks: RecoveredBlock[]; via: "anydoc:hosted" | "local" }
) & {
	/** A short, user-facing note about HOW this conversion happened (a parked
	 *  gate, a rejected key, where a hosted conversion ran). UI only — the model
	 *  gets the blocks and their notes, not this. */
	hint?: string;
};

/** Why local recovery could not deliver — travels on the rethrown needsOcr
 *  error so the tool can turn it into an install hint (UI-side). Derived from
 *  the recovery's own union, so a new reason cannot drift apart. */
export type LocalFailure = Extract<Recovery, { ok: false }>["reason"];

// ── The fallback chain ────────────────────────────────────────

export interface ConvertDeps {
	/** The anydoc engine (dynamic import in prod; `{ ocr: "hosted" }` runs the
	 *  server-side OCR path). */
	toMarkdown: (path: string, opts?: { ocr: "hosted"; apiKey?: string }) => Promise<string>;
	/** The hosted gate (see HostedGate). */
	hosted: HostedGate;
	/** Rate limit around hosted calls. */
	limit: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Local recovery of a PDF anydoc refused: text runs (anydoc on a page
	 *  subset) + OCR'd image-only pages, as page-ordered blocks. */
	recover: (
		pdfPath: string,
		flagged: number[],
		pageCount: number,
		opts?: { signal?: AbortSignal; onProgress?: (note: string) => void },
	) => Promise<Recovery>;
}

/**
 * Run the chain:
 * 1. anydoc local (all office formats) → markdown;
 * 2. `needsOcr` → hosted OCR (unless the gate has it parked) → blocks;
 * 3. `needsOcr` + pdf → local recovery → blocks;
 * 4. otherwise the original error propagates (the caller adds the hint).
 */
export async function convertDocument(
	path: string,
	ext: string,
	deps: ConvertDeps,
	opts: { signal?: AbortSignal; now?: Date; onProgress?: (note: string) => void } = {},
): Promise<ConvertedDocument> {
	const now = opts.now ?? new Date();
	try {
		// anydoc converts the whole document or nothing: one scanned page makes
		// it reject everything, text pages included (verified).
		return { kind: "markdown", text: await deps.toMarkdown(path), via: "anydoc" };
	} catch (err) {
		if ((err as { code?: string })?.code !== "needsOcr") throw err;

		const pages = (err as { pages?: number[] }).pages ?? [];
		const pageCount = (err as { pageCount?: number }).pageCount ?? 0;

		/**
		 * Anything the user should hear about the HOSTED side: a parked gate, an
		 * exhausted quota, a rejected key. It is the same slot in both endings —
		 * a local failure must not bury it (`withLocalReason` carries it), and a
		 * successful local recovery still surfaces it as the result's hint.
		 */
		let hostedHint: string | undefined;
		// Without a page count we cannot attribute anything hosted returns, and
		// a block with an empty `pages` would contradict the shape we promise.
		const canAttribute = pageCount > 0;
		const parked = canAttribute ? await deps.hosted.skipped(now) : null;
		if (canAttribute && parked) {
			// Say why we did not ask: otherwise a parked gate is invisible.
			hostedHint = `hosted OCR paused until ${new Date(parked.until).toLocaleDateString()}: ${parked.reason}`;
		} else if (canAttribute) {
			try {
				const hosted = await deps.limit(() => deps.toMarkdown(path, { ocr: "hosted" }));
				return {
					kind: "blocks",
					// No note on the block: where the text came from is nothing the model
					// can act on. The provenance rides `hint` — the user is the one who
					// cares that this document left the machine.
					blocks: [{ pages: pageRange(pageCount), text: hosted }],
					via: "anydoc:hosted",
					hint: hostedNote(pages, pageCount),
				};
			} catch (hostedErr) {
				const message = hostedErr instanceof Error ? hostedErr.message : String(hostedErr);
				const exhausted = hostedExhaustion(message, now);
				if (exhausted) {
					await deps.hosted.record(exhausted);
					hostedHint = `hosted OCR paused: ${exhausted.reason}`;
				} else if (hostedKeyRejected(message)) {
					// Worth surfacing even when local recovery succeeds — silence
					// would hide a broken configuration.
					hostedHint = "Firecrawl Parse rejected the API key — check FIRECRAWL_API_KEY";
				}
			}
		}

		// Recovery restores the text pages anydoc dropped, so it needs to know
		// the document's shape; without it we would silently lose pages.
		if (ext === ".pdf" && pageCount > 0) {
			const recovered = await deps.recover(path, pages, pageCount, opts);
			if (recovered.ok) {
				// Both hints can be true at once (a broken key AND a local
				// diagnostic); the user should see whichever exist.
				const notes = [hostedHint, recovered.hint].filter(Boolean).join(" · ");
				return { kind: "blocks", blocks: recovered.blocks, via: "local", ...(notes ? { hint: notes } : {}) };
			}
			throw withLocalReason(err, { localReason: recovered.reason, localHint: recovered.hint, hostedHint });
		}
		throw hostedHint ? Object.assign(err as Error, { hostedHint }) : err;
	}
}

const pageRange = (pageCount: number): number[] => Array.from({ length: pageCount }, (_, i) => i + 1);

/** What a failed conversion tells its caller: anydoc's code, plus the recovery
 *  and local-engine guidance that belongs beside it. This is the one definition
 *  — the error we throw, the tool that reads it and the tests all share it. */
export interface ConversionFailure {
	code?: string;
	localReason?: LocalFailure;
	/** A hosted-side problem worth telling the user about. */
	hostedHint?: string;
	/** The local engine's own guidance, when it is the thing missing. */
	localHint?: string;
}

/** Attach the recovery failure to the propagated error — the tool turns it
 *  into the install hint, and nothing else needs to change shape. */
function withLocalReason(err: unknown, info: Omit<ConversionFailure, "code"> & { localReason: LocalFailure }): Error {
	const e = err instanceof Error ? err : new Error(String(err));
	// Separate slots: one failing reason must not swallow the other's advice.
	return Object.assign(e, {
		localReason: info.localReason,
		...(info.localHint ? { localHint: info.localHint } : {}),
		...(info.hostedHint ? { hostedHint: info.hostedHint } : {}),
	});
}
