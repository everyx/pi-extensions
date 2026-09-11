/**
 * pi-read-doc — enhanced read for office docs via anydoc.
 *
 * Tool `read_doc` converts doc/docx/ppt/xlsx etc. + pdf via @firecrawl/anydoc
 * (Rust). Any doc anydoc can convert comes back as markdown. When it refuses a
 * PDF with `needsOcr`, the local recovery path (pdf/recover.ts) takes over:
 * text pages are converted through a page subset (markdown survives), image-
 * only pages are rasterized and OCR'd (ocr/), and the result is a JSON array
 * of page blocks — page images are FIELDS there, never markdown figures, so
 * the model never mistakes a scanned page for an illustration.
 *
 * This file keeps the tool wiring, the view, the temp-dir lifecycle and the
 * real adapters. The chain lives in convert.ts, paging in pdf/, OCR behind the
 * engine seam in ocr/engine.ts.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { createToolView, expandHintText } from "@everyx/pi-ui/view.js";
import { Type } from "typebox";
import { blocksForLlm, blocksToText } from "./blocks.js";
import {
	type ConversionFailure,
	type ConvertDeps,
	type ConvertedDocument,
	convertDocument,
	type LocalFailure,
} from "./convert.js";
import { fileHostedGate } from "./hosted-gate.js";
import { createRapidOcr } from "./ocr/rapidocr.js";
import { createPdfTools, POPPLER_HINT } from "./pdf/poppler.js";
import { DEFAULT_BUDGET_MS, recoverPdf } from "./pdf/recover.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRunCli } from "./run.js";

const hostedLimiter = createRateLimiter(2); // 2 qps for hosted Parse

// Exported for tests: the extension's default export is the pi entry; these
// domain constants are the single source the tests pin to.
export const OFFICE_EXTS = new Set([
	".doc",
	".docx",
	".docm",
	".ppt",
	".pps",
	".pot",
	".pptx",
	".pptm",
	".ppsx",
	".ppsm",
	".xls",
	".xlsx",
	".xlsm",
	".xlsb",
	".odt",
	".ods",
	".odp",
	".rtf",
	".epub",
	".csv",
	".pdf",
]);

export function extOf(path: string): string {
	const i = path.lastIndexOf(".");
	return i >= 0 ? path.slice(i).toLowerCase() : "";
}

/** What to tell the user when local recovery is what failed. Only the missing
 *  binary needs wording from here: every other reason arrives with its own
 *  guidance on the error (the engine's install hint, the step that broke). */
const LOCAL_HINTS: Partial<Record<LocalFailure, string>> = {
	"poppler-missing": POPPLER_HINT,
};

/**
 * Failure result for a conversion error. The LLM gets the terse engine
 * message; the config guidance — only the user can act on it — rides
 * `details.error`, the one details field the card renders (`pi-ui/view.ts`
 * forwards just `data` + `error` to the view; a sibling `hint` key has no
 * reader and is written to nobody).
 */
export function conversionFailure(msg: string, info: ConversionFailure = {}) {
	const { code, localReason, hostedHint, localHint } = info;
	// Cancelled is not a failure: the user stopped it, so both layers hear the
	// one true sentence, and the card shows the stop state (pi-ui's ■) rather
	// than a ✗ that reads like the document was broken.
	if (localReason === "cancelled") {
		return {
			content: [{ type: "text" as const, text: "read cancelled" }],
			details: { error: "read cancelled", status: "stop" as const },
			isError: true as const,
		};
	}
	const hint =
		code !== "needsOcr"
			? ""
			: localReason
				? (localHint ?? LOCAL_HINTS[localReason])
				: "Scanned pages: run hosted OCR (FIRECRAWL_API_KEY) or local OCR; see docs.";
	const detail = [msg, hint, hostedHint].filter(Boolean).join("\n");
	return {
		content: [{ type: "text" as const, text: msg }],
		// `error` is the card's channel; `code` computed the hint above and has no
		// renderer, so it is not emitted.
		details: { error: detail },
		isError: true as const,
	};
}

const ReadDocSchema = Type.Object({
	path: Type.String(),
});

type ReadDocData = {
	content: string;
	/** Set when content is LLM-truncated — the card expand shows the full text. */
	fullContent?: string;
	/** Short UI-only note about how the conversion happened (a parked hosted
	 *  gate, a rejected key) — shown in the card header, never sent to the model. */
	hint?: string;
};

const readDocView = createToolView<Record<string, unknown>, ReadDocData>({
	name: "read_doc",
	title: (ctx: { args: Record<string, unknown> }) => String(ctx.args.path ?? ""),
	tail: (ctx: { status: string }) =>
		ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working…" : undefined,
	// How the conversion happened (a parked gate, a rejected key, an OCR
	// diagnostic) is meta, not status: the tail slot is a state word, and "·"
	// is reserved for meta separators (root SPEC 统一视觉语法).
	meta: (ctx: { result?: { data?: ReadDocData } }) => {
		const data = ctx.result?.data;
		if (!data) return undefined;
		// Header-only card: everything the read produced is behind ctrl+o, so the
		// affordance is owed (pi-ui's truncated-card contract).
		const items = [data.hint, expandHintText(data)].filter(Boolean) as string[];
		return items.length ? items : undefined;
	},
	body: {
		text: (ctx: { expanded?: boolean; result?: { data?: ReadDocData } }) =>
			ctx.expanded ? (ctx.result?.data?.fullContent ?? ctx.result?.data?.content ?? "") : "",
	},
});

// ── Local recovery wiring (poppler + the OCR engine) ──────────

/**
 * How long one local recovery may take, in milliseconds
 * (`PI_READ_DOC_OCR_TIMEOUT_MS`). Time is the knob, not page count: a scanned
 * page costs seconds, but how many seconds depends on how much text it
 * carries, so pages cannot express "how long may this take". Read per call so
 * a launcher can change it without editing code.
 */
export function ocrBudgetMs(): number {
	const raw = Number(process.env.PI_READ_DOC_OCR_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_MS;
}

/** Page images live here — the model may `read` any of them later to check the
 *  original, and a resumed session's transcript still points at them, so they
 *  outlive us (tmp's own cleanup is the janitor). One directory per document,
 *  so a document always lands in the same place. The images are NOT reused
 *  across reads (each read renders its own, tagged), so the directory keeps
 *  the history until tmp's own cleanup takes it. */
function artifactDir(pdfPath: string): string {
	return join(tmpdir(), `pi-read-doc-${createHash("sha1").update(pdfPath).digest("hex").slice(0, 8)}`);
}

const runCli = createRunCli();
const pdfTools = createPdfTools({ run: runCli });
const ocrEngine = createRapidOcr({ run: runCli });

// ── LLM budget truncation (root SPEC: LLM context 截断保护) ───────────

/** Head-truncate to the LLM budget (documents read top-down, like `read`)
 *  via pi's own truncateHead — pi-bash parity: 2000 lines / 50KB, counted in
 *  UTF-8 bytes (the same implementation pi's read/bash tools use, so the
 *  marker's numbers are true). The full text stays in details.data.
 *  fullContent for the card expand. */
export function truncateForLlm(text: string): { text: string; truncated: boolean } {
	const r = truncateHead(text);
	if (!r.truncated) return { text, truncated: false };
	return {
		text: `${r.content}\n(truncated: first ${r.outputLines} lines / ${r.outputBytes} bytes; total ${r.totalLines} lines / ${r.totalBytes} bytes)`,
		truncated: true,
	};
}

/** Real adapters for the conversion chain (convert.ts runs the walk). */
const defaultDeps: ConvertDeps = {
	toMarkdown: async (path, opts) => {
		const { toMarkdown } = await import("@firecrawl/anydoc");
		if (opts?.ocr === "hosted") return toMarkdown(path, { ...opts, apiKey: process.env.FIRECRAWL_API_KEY });
		return toMarkdown(path);
	},
	hosted: fileHostedGate,
	limit: hostedLimiter,
	recover: async (pdfPath, flagged, pageCount, opts) => {
		const artifacts = artifactDir(pdfPath);
		await mkdir(artifacts, { recursive: true });
		// Scratch holds the intermediate single-page PDFs — removed as soon as
		// the recovery returns, unlike the page images.
		const scratch = await mkdtemp(join(tmpdir(), "pi-read-doc-scratch-"));
		try {
			return await recoverPdf(pdfPath, flagged, pageCount, {
				pdf: pdfTools,
				engine: ocrEngine,
				convertSubset: async (subPdf) => (await import("@firecrawl/anydoc")).toMarkdown(subPdf),
				dirs: { scratch, artifacts },
				budgetMs: ocrBudgetMs(),
				...(opts?.signal ? { signal: opts.signal } : {}),
				...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
			});
		} finally {
			await rm(scratch, { recursive: true, force: true }).catch(() => {});
		}
	},
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_doc",
		label: "Read a document",
		description: "Read office documents (Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV).",
		promptSnippet: "Read office documents",
		promptGuidelines: ["For office documents, use read_doc instead of read."],
		parameters: ReadDocSchema,
		...readDocView,
		async execute(_id, raw, signal, onUpdate) {
			const { path } = raw as { path: string };
			const ext = extOf(path);
			// A scan costs seconds per page: say which step we are on while it
			// runs, instead of one silent "working…" for two minutes. It rides
			// `details.data`, the channel the card actually renders.
			const onProgress = onUpdate
				? (note: string) => {
						onUpdate({
							content: [{ type: "text", text: note }],
							details: { data: { content: note, fullContent: note, hint: note } },
						});
					}
				: undefined;
			if (!OFFICE_EXTS.has(ext)) {
				try {
					const buf = await readFile(path, "utf-8");
					const { text, truncated } = truncateForLlm(buf);
					return {
						content: [{ type: "text" as const, text }],
						details: {
							data: {
								content: text,
								...(truncated ? { fullContent: buf } : {}),
							},
						},
					};
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return { content: [{ type: "text" as const, text: msg }], details: { error: msg }, isError: true as const };
				}
			}
			let doc: ConvertedDocument;
			try {
				doc = await convertDocument(path, ext, defaultDeps, {
					...(signal ? { signal } : {}),
					...(onProgress ? { onProgress } : {}),
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const { code, localReason, hostedHint, localHint } = e as ConversionFailure;
				return conversionFailure(msg, { code, localReason, hostedHint, localHint });
			}
			// Two shapes, one rule: everything anydoc converts stays markdown;
			// pages that had to be read from images come back as JSON blocks
			// (image paths are fields there, never markdown figures).
			if (doc.kind === "blocks") {
				const blocks = doc.blocks;
				const { json } = blocksForLlm(blocks);
				return {
					content: [{ type: "text" as const, text: json }],
					details: {
						// The card renders the readable form; the JSON above is the
						// model's copy (budgeted separately — the UI is not a context).
						data: {
							content: blocksToText(blocks),
							...(doc.hint ? { hint: doc.hint } : {}),
						},
					},
				};
			}
			const { text, truncated } = truncateForLlm(doc.text);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					data: {
						content: text,
						...(truncated ? { fullContent: doc.text } : {}),
					},
				},
			};
		},
	});
}
