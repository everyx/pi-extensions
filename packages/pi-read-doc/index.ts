/**
 * pi-read-doc — enhanced read for office docs via anydoc.
 *
 * Tool `read_doc` converts doc/docx/ppt/xlsx etc. + pdf to markdown via
 * @firecrawl/anydoc (Rust, 4.4ms). The fallback chain (anydoc → hosted OCR →
 * rapidocr) + its quota gate live in convert.ts behind an injected interface
 * (testable with fakes); this file keeps the tool wiring, the view, and the
 * real adapters (anydoc import, rapid CLI). LLM text is head-truncated to
 * the bash budget (root SPEC: UI 渲染源不截断 — the card expand shows
 * fullContent). Header-only folding (read-like).
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { createToolView } from "@everyx/pi-ui/view.js";
import { Type } from "typebox";

import { type ConvertDeps, type ConvertedDocument, convertDocument, fileQuota } from "./convert.js";
import { createRateLimiter } from "./rate-limit.js";

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

const ReadDocSchema = Type.Object({
	path: Type.String(),
});

type ReadDocData = {
	content: string;
	/** Set when content is LLM-truncated — the card expand shows the full text. */
	fullContent?: string;
	convertedVia: ConvertedDocument["via"] | "raw";
	ext: string;
};

const readDocView = createToolView<Record<string, unknown>, ReadDocData>({
	name: "read_doc",
	title: (ctx: { args: Record<string, unknown> }) => String(ctx.args.path ?? ""),
	tail: (ctx: { status: string }) =>
		ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working…" : undefined,
	body: {
		text: (ctx: { expanded?: boolean; result?: { data?: ReadDocData } }) =>
			ctx.expanded ? (ctx.result?.data?.fullContent ?? ctx.result?.data?.content ?? "") : "",
	},
});

async function hasRapidOcr(): Promise<boolean> {
	for (const bin of ["python", "python3"]) {
		const ok = await new Promise<boolean>((resolve) => {
			// spawn's `timeout` kills the probe — no manual timer (a pending
			// setTimeout would hold the event loop for its full duration).
			const py = spawn(bin, ["-c", "from rapidocr import RapidOCR"], { timeout: 5_000 });
			py.on("error", () => resolve(false));
			py.on("close", (code) => resolve(code === 0));
		});
		if (ok) return true;
	}
	return false;
}

async function tryRapidOcr(pdfPath: string): Promise<string | null> {
	if (!(await hasRapidOcr())) return null;
	for (const bin of ["python", "python3"]) {
		const result = await new Promise<string | null>((resolve) => {
			const py = spawn(
				bin,
				[
					"-c",
					`from rapidocr import RapidOCR; import sys; ocr=RapidOCR(); r=ocr(sys.argv[1]); out=[]\nif r and r[0]:\n for l in r[0]: out.append(l[1] if len(l)>1 else str(l))\n print("\\n".join(out))\nelse: print("")`,
					pdfPath,
				],
				{ timeout: 30_000 },
			);
			let out = "";
			let err = "";
			py.stdout?.on("data", (d) => (out += d));
			py.stderr?.on("data", (d) => (err += d));
			py.on("error", () => resolve(null));
			py.on("close", (code) => {
				if (code === 0 && out.trim()) resolve(out.trim());
				else if (err.includes("ModuleNotFoundError") || err.includes("No module")) resolve(null);
				else resolve(null);
			});
			// spawn's `timeout` (30s) kills a hung OCR — no manual timer.
		});
		if (result !== null) return result;
	}
	return null;
}

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
	quota: fileQuota,
	limit: hostedLimiter,
	rapidOcr: tryRapidOcr,
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_doc",
		label: "Read a document",
		description: "Read office documents as markdown (Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV).",
		promptSnippet: "Read office documents as markdown",
		promptGuidelines: ["For office documents, use read_doc instead of read."],
		parameters: ReadDocSchema,
		...readDocView,
		async execute(_id, raw, _signal) {
			const { path } = raw as { path: string };
			const ext = extOf(path);
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
								convertedVia: "raw" as const,
								ext,
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
				doc = await convertDocument(path, ext, defaultDeps);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const code = (e as { code?: string })?.code;
				// LLM text stays terse; the config path (hosted OCR key, local
				// rapidocr) is a UI-side hint — the LLM cannot act on it.
				const hint =
					code === "needsOcr" ? "Scanned pages: run hosted OCR (FIRECRAWL_API_KEY) or local rapidocr; see docs." : "";
				return {
					content: [{ type: "text" as const, text: msg }],
					details: { error: msg, code, ...(hint ? { hint } : {}) },
					isError: true as const,
				};
			}
			const { text, truncated } = truncateForLlm(doc.text);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					data: {
						content: text,
						...(truncated ? { fullContent: doc.text } : {}),
						convertedVia: doc.via,
						ext,
					},
				},
			};
		},
	});
}
