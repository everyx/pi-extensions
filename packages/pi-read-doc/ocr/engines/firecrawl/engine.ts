/**
 * pi-read-doc — the firecrawl engine: the one way a document leaves this machine.
 *
 * It hands the WHOLE document to Firecrawl Parse (through anydoc's hosted mode):
 * Parse has no page selection, so there is no "just the scanned pages". Which
 * pages had to be read as images we do know, and the user is told.
 *
 * This file holds the package's only upload call site. A config without
 * `firecrawl` never builds this engine, so that call cannot happen at all — the
 * guarantee `PI_READ_DOC_OCR_ENGINE=rapidocr` rests on.
 */

import type { Engine, ServeContext, ServeResult } from "../../../convert.js";
import { formatPages } from "../../../page-labels.js";
import { createRateLimiter } from "../../../rate-limit.js";
import { type FirecrawlGate, fileFirecrawlGate, firecrawlExhaustion, firecrawlKeyRejected } from "./gate.js";

export interface FirecrawlEngineDeps {
	/** The upload itself (production: anydoc's hosted mode). Injectable so tests
	 *  can make it throw instead of reaching the network. */
	upload?: (path: string) => Promise<string>;
	gate?: FirecrawlGate;
	limit?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * What the user should know about a hosted conversion. The service converts the
 * whole document into one blob the pages cannot be split out of — but which
 * pages it had to read as images we know exactly. It rides the card's hint, not
 * the model's payload: where the text came from is nothing the model can act on.
 */
function sourceNote(flagged: readonly number[], pageCount: number): string {
	const listed =
		flagged.length >= pageCount
			? "every page was"
			: flagged.length > 8
				? `${flagged.length} pages were`
				: `pages ${formatPages(flagged)} were`;
	return `${listed} read by firecrawl OCR — the document was uploaded`;
}

export function createFirecrawlEngine(deps: FirecrawlEngineDeps = {}): Engine {
	const upload =
		deps.upload ??
		(async (path: string) => {
			const { toMarkdown } = await import("@firecrawl/anydoc");
			return toMarkdown(path, { ocr: "hosted", apiKey: process.env.FIRECRAWL_API_KEY });
		});
	const gate = deps.gate ?? fileFirecrawlGate;
	const limit = deps.limit ?? createRateLimiter(2); // Parse asks for 2 qps

	return {
		id: "firecrawl",

		async serve(ctx: ServeContext): Promise<ServeResult> {
			// A parked gate means "do not ask": saying why is the whole point of
			// parking, otherwise the feature is invisible.
			const parked = await gate.skipped(ctx.now);
			if (parked) {
				const until = new Date(parked.until).toLocaleDateString();
				return { ok: false, hint: `firecrawl OCR paused until ${until}: ${parked.reason}` };
			}

			try {
				const text = await limit(() => upload(ctx.path));
				return {
					ok: true,
					blocks: [{ pages: Array.from({ length: ctx.pageCount }, (_, i) => i + 1), text }],
					hint: sourceNote(ctx.pages, ctx.pageCount),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// A real limit: park the engine until asking again makes sense.
				const exhausted = firecrawlExhaustion(message, ctx.now);
				if (exhausted) {
					await gate.record(exhausted);
					return { ok: false, hint: `firecrawl OCR paused: ${exhausted.reason}` };
				}
				// Worth surfacing even when a later engine succeeds — silence would
				// hide a broken configuration.
				if (firecrawlKeyRejected(message)) {
					return { ok: false, hint: "Firecrawl Parse rejected the API key — check FIRECRAWL_API_KEY" };
				}
				// Anything else (500s, a network blip) is not the user's to act on,
				// so it does not go on the card.
				return { ok: false };
			}
		},
	};
}
