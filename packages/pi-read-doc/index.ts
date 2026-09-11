/**
 * pi-read-doc — enhanced read for office docs via anydoc.
 *
 * Tool `read_doc` converts doc/docx/ppt/xlsx etc. + pdf via @firecrawl/anydoc
 * (Rust). Any doc anydoc can convert comes back as markdown. When it refuses a
 * PDF with `needsOcr`, the configured OCR engines take over (see convert.ts for
 * the walk and the contract, ocr/engines/ for the engines themselves): the
 * result is a JSON array of page blocks — page images are FIELDS there, never
 * markdown figures, so the model never mistakes a scanned page for an
 * illustration.
 *
 * This file is the composition root: it parses the configuration, asks the
 * registry for the engines it names, and hands both to the walk. It also holds
 * the tool wiring, the view, and the result's two text layers (terse for the
 * model, actionable for the card).
 */

import { readFile } from "node:fs/promises";
import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { createToolView, expandHintText } from "@everyx/pi-ui/view.js";
import { Type } from "typebox";
import { blocksForLlm, blocksToText } from "./blocks.js";
import {
	type ConversionFailure,
	type ConvertedDocument,
	convertDocument,
	ENGINE_IDS,
	type EngineId,
} from "./convert.js";
import { enginesFor } from "./ocr/engines/registry.js";

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

// ── Configuration: PI_READ_DOC_OCR_ENGINE ─────────────────────

/** Which engines may be asked, in the order they are tried. */
export type OcrConfig = { engines: EngineId[] } | { invalid: true; legal: string };

const LEGAL = `${ENGINE_IDS.join(", ")}, off`;

/**
 * Parse `PI_READ_DOC_OCR_ENGINE`: a comma-separated, ordered list of engine
 * names (or `off`). Unset means the default order — local first, so a scanned
 * document stays on this machine whenever the local engine can read it.
 *
 * Fail-closed by construction: a value we cannot read is refused rather than
 * silently replaced with the default — "I locked it down" must never turn into
 * "it uploaded". Pure: the caller reads the environment on every call, so a
 * launcher can change it without a reload.
 */
const invalidConfig = (): OcrConfig => ({ invalid: true, legal: LEGAL });

export function parseOcrEngine(raw: string | undefined): OcrConfig {
	if (raw === undefined) return { engines: ["rapidocr", "firecrawl"] };
	const items = raw
		.trim()
		.toLowerCase()
		.split(",")
		.map((part) => part.trim());
	if (items.length === 1 && items[0] === "") return invalidConfig();
	if (items.some((item) => item === "")) return invalidConfig();
	if (items.includes("off")) {
		// `off` alone means "no engine"; next to one it contradicts itself.
		return items.length === 1 ? { engines: [] } : invalidConfig();
	}
	const unknown = items.find((item) => !(ENGINE_IDS as readonly string[]).includes(item));
	if (unknown) return invalidConfig();
	return { engines: [...new Set(items)] as EngineId[] };
}

// ── The result's two layers ───────────────────────────────────

/**
 * Failure result for a conversion error. The LLM gets the terse message; the
 * guidance — only the user can act on it — rides `details.error`, the one
 * details field the card renders (`pi-ui/view.ts` forwards just `data` + `error`
 * to the view; a sibling `hint` key has no reader and is written to nobody).
 *
 * The configuration is never explained to the model: it cannot change an
 * environment variable, so those sentences are tokens paid for nothing.
 */
export function conversionFailure(msg: string, info: ConversionFailure = {}, config?: OcrConfig) {
	// Cancelled is not a failure: the user stopped it, so both layers hear the
	// one true sentence, and the card shows the stop state (pi-ui's ■) rather
	// than a ✗ that reads like the document was broken.
	if (info.cancelled) {
		return {
			content: [{ type: "text" as const, text: "read cancelled" }],
			details: { error: "read cancelled", status: "stop" as const },
			isError: true as const,
		};
	}

	// An invalid configuration is the whole story: the read failed because the
	// switch is unreadable, not because the document is.
	if (info.configLegal) {
		const text = "OCR unavailable: PI_READ_DOC_OCR_ENGINE is invalid";
		return {
			content: [{ type: "text" as const, text }],
			details: {
				error: `${text}\nuse one of: ${info.configLegal} (comma-separated, in the order to try)`,
			},
			isError: true as const,
		};
	}

	const notes = [...(info.engineHints ?? [])];
	if (info.ocrNeeded && config && !("invalid" in config)) {
		if (config.engines.length === 0) {
			notes.push("PI_READ_DOC_OCR_ENGINE=off: OCR is disabled for this read");
		} else if (!config.engines.includes("firecrawl")) {
			notes.push("PI_READ_DOC_OCR_ENGINE has no cloud engine: nothing was uploaded");
		}
	}
	// Nothing engine-specific to say (a transient failure, say): the user still
	// needs somewhere to look, so the old fallback keeps its job.
	if (info.code === "needsOcr" && notes.length === 0) {
		notes.push("Scanned pages: no configured OCR engine could read them; see the PI_READ_DOC_OCR_ENGINE docs.");
	}

	return {
		content: [{ type: "text" as const, text: msg }],
		details: { error: [msg, ...notes].join("\n") },
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
	/** Short UI-only note about how the conversion happened (a parked
	 *  firecrawl gate, a rejected key, which engine ran) — shown in the card header, never
	 *  sent to the model. */
	hint?: string;
};

const readDocView = createToolView<Record<string, unknown>, ReadDocData>({
	name: "read_doc",
	title: (ctx: { args: Record<string, unknown> }) => String(ctx.args.path ?? ""),
	tail: (ctx: { status: string }) =>
		ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working…" : undefined,
	// How the conversion happened (a parked gate, a rejected key, an OCR
	// diagnostic, which engine ran) is meta, not status: the tail slot is a
	// state word, and "·" is reserved for meta separators (root SPEC 统一视觉语法).
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

/** The parser: anydoc converts locally. It either produces markdown for the
 *  whole document or rejects it with `needsOcr` — never half a document. */
async function parseDocument(path: string): Promise<string> {
	const { toMarkdown } = await import("@firecrawl/anydoc");
	return toMarkdown(path);
}

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
			const config = parseOcrEngine(process.env.PI_READ_DOC_OCR_ENGINE);
			// The engines the config names — in that order. An invalid config gets
			// no engines at all: the walk reports it the moment OCR is needed
			// (documents that do not need OCR keep working).
			const engines = "invalid" in config ? [] : enginesFor(config.engines);
			let doc: ConvertedDocument;
			try {
				doc = await convertDocument(
					path,
					ext,
					{ parse: parseDocument, engines },
					{
						...(signal ? { signal } : {}),
						...(onProgress ? { onProgress } : {}),
						...("invalid" in config ? { configInvalid: { legal: config.legal } } : {}),
					},
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const info = e as ConversionFailure;
				return conversionFailure(msg, info, config);
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
