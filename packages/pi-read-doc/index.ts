/**
 * pi-read-doc — enhanced read for office docs via anydoc.
 *
 * Tool `read_doc` converts doc/docx/ppt/xlsx etc. + pdf to markdown via
 * @firecrawl/anydoc (Rust, 14 formats, 4.4ms). Text-based PDFs convert
 * locally; scanned pages hit `needsOcr` → auto fallback: hosted (Firecrawl
 * Parse, 1k/月) → rapidocr (local python-rapidocr, text-only). Header-only
 * folding (read-like) — collapsed shows only header, expanded shows full.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createToolView } from "@everyx/pi-ui/view.js";
import { Type } from "typebox";

// ── Rate limiter (hosted OCR) ───────────────────────────────
function createRateLimiter(qps: number) {
	let last = 0;
	let chain: Promise<void> = Promise.resolve();
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (qps <= 0) return fn();
		const gap = 1000 / qps;
		const task = chain.then(async () => {
			const now = Date.now();
			const wait = Math.max(0, last + gap - now);
			if (wait) await new Promise((r) => setTimeout(r, wait));
			last = Date.now();
			return fn();
		});
		chain = task.then(
			() => {},
			() => {},
		);
		return task;
	};
}
const hostedLimiter = createRateLimiter(2); // 2 qps for Parse
const QUOTA_LIMIT = 1000;

function quotaPath(): string {
	return join(getAgentDir(), "pi-read-doc.json");
}
function monthKey(d = new Date()): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function dateKey(d = new Date()): string {
	return d.toISOString().slice(0, 10);
}
async function loadQuota(): Promise<number> {
	try {
		const raw = await readFile(quotaPath(), "utf-8");
		const j = JSON.parse(raw) as { quota?: { updatedAt?: string; used?: number } };
		if (!j.quota?.updatedAt || j.quota.updatedAt.slice(0, 7) !== monthKey()) return 0;
		return j.quota?.used ?? 0;
	} catch {
		return 0;
	}
}
async function saveQuota(n: number): Promise<void> {
	try {
		const p = quotaPath();
		await mkdir(getAgentDir(), { recursive: true });
		const quota = { updatedAt: dateKey(), used: n, limit: QUOTA_LIMIT };
		await writeFile(p, JSON.stringify({ quota }, null, 2), "utf-8");
	} catch {}
}

const OFFICE_EXTS = new Set([
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

function extOf(path: string): string {
	const i = path.lastIndexOf(".");
	return i >= 0 ? path.slice(i).toLowerCase() : "";
}

const ReadDocSchema = Type.Object({
	path: Type.String({ description: "Path to the document (office/pdf) to read" }),
});

type ReadDocData = { content: string; convertedVia: "anydoc" | "anydoc:hosted" | "rapid" | "raw"; ext: string };

const readDocView = createToolView<Record<string, unknown>, ReadDocData>({
	name: "read_doc",
	title: (ctx: { args: Record<string, unknown> }) => String(ctx.args.path ?? ""),
	tail: (ctx: { status: string }) =>
		ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working…" : undefined,
	meta: undefined,
	body: {
		text: (ctx: { expanded?: boolean; result?: { data?: ReadDocData } }) =>
			ctx.expanded ? (ctx.result?.data?.content ?? "") : "",
	},
});

function quotaForPages(pages: number): number {
	return pages || 1;
}

async function hasRapidOcr(): Promise<boolean> {
	for (const bin of ["python", "python3"]) {
		const ok = await new Promise<boolean>((resolve) => {
			const py = spawn(bin, ["-c", "from rapidocr import RapidOCR"], { timeout: 5_000 });
			py.on("error", () => resolve(false));
			py.on("close", (code) => resolve(code === 0));
			setTimeout(() => {
				py.kill();
				resolve(false);
			}, 5_000);
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
			setTimeout(() => {
				py.kill();
				resolve(null);
			}, 30_000);
		});
		if (result !== null) return result;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_doc",
		label: "Read a document",
		description: "Read office documents as markdown (Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV).",
		promptSnippet: "Read office documents as markdown",
		promptGuidelines: ["For office documents, use read_doc to get markdown."],
		parameters: ReadDocSchema,
		...readDocView,
		async execute(_id, raw, _signal) {
			const { path } = raw as { path: string };
			const ext = extOf(path);
			const isOffice = OFFICE_EXTS.has(ext);
			if (!isOffice) {
				try {
					const buf = await readFile(path, "utf-8");
					return {
						content: [{ type: "text" as const, text: buf }],
						details: { data: { content: buf, convertedVia: "raw" as const, ext } },
					};
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return { content: [{ type: "text" as const, text: msg }], details: { error: msg }, isError: true as const };
				}
			}
			try {
				const { toMarkdown } = await import("@firecrawl/anydoc");
				try {
					const md = await toMarkdown(path);
					return {
						content: [{ type: "text" as const, text: md }],
						details: { data: { content: md, convertedVia: "anydoc" as const, ext } },
					};
				} catch (err: unknown) {
					const code = (err as { code?: string })?.code;
					if (code === "needsOcr") {
						const used = await loadQuota();
						if (used < QUOTA_LIMIT) {
							try {
								const mdHosted = await hostedLimiter(() =>
									toMarkdown(path, {
										ocr: "hosted" as const,
										apiKey: process.env.FIRECRAWL_API_KEY,
									}),
								);
								const pages = (err as { pages?: unknown[] })?.pages?.length ?? 1;
								await saveQuota(used + quotaForPages(pages));
								return {
									content: [{ type: "text" as const, text: mdHosted }],
									details: { data: { content: mdHosted, convertedVia: "anydoc:hosted" as const, ext } },
								};
							} catch {
								// hosted failed → fall through to rapid
							}
						}
						if (ext === ".pdf") {
							const rapid = await tryRapidOcr(path);
							if (rapid) {
								return {
									content: [{ type: "text" as const, text: rapid }],
									details: { data: { content: rapid, convertedVia: "rapid" as const, ext } },
								};
							}
						}
						throw err;
					}
					throw err;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const code = (e as { code?: string })?.code;
				const hint =
					code === "needsOcr" ? " (scanned pages, try hosted with FIRECRAWL_API_KEY or rapidocr locally)" : "";
				return {
					content: [{ type: "text" as const, text: msg + hint }],
					details: { error: msg, code },
					isError: true as const,
				};
			}
		},
	});
}
