/**
 * pi-read-doc — document conversion (fallback chain + quota gate).
 *
 * The package's core concept behind one interface: office path → clean
 * markdown. The chain (anydoc local → hosted OCR → local rapidocr) and its
 * quota gate live here; the real adapters (anydoc engine, quota file, rapid
 * CLI) are injected via ConvertDeps, so tests drive the chain with fakes —
 * no engine binary, no network.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Which step produced the document (card echo + diagnostics). */
export type ConvertedVia = "anydoc" | "anydoc:hosted" | "rapid";

export interface ConvertedDocument {
	/** Full converted text — the LLM-budget truncation is the caller's
	 *  concern (root SPEC: UI 渲染源不截断). */
	text: string;
	via: ConvertedVia;
}

/** Monthly hosted-OCR budget (user-level cost self-defense, not the
 *  upstream quota). */
export const QUOTA_LIMIT = 1000;

/** Quota store for hosted OCR (user-level, monthly reset). */
export interface QuotaStore {
	/** Pages used this month. */
	used(): Promise<number>;
	/** Record newly-used pages. */
	charge(pages: number): Promise<void>;
}

export interface ConvertDeps {
	/** The anydoc engine (dynamic import in prod; `{ ocr: "hosted" }` runs
	 *  the server-side OCR path). */
	toMarkdown: (path: string, opts?: { ocr: "hosted"; apiKey?: string }) => Promise<string>;
	/** Monthly hosted-OCR budget gate. */
	quota: QuotaStore;
	/** Rate limit around hosted calls. */
	limit: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Local rapidocr for scanned PDFs; null when unavailable or failed. */
	rapidOcr: (pdfPath: string) => Promise<string | null>;
}

// ── File-backed quota store (~/.pi/read-doc.json) ──────────────

// User-scoped extension state lives at the pi config root (~/.pi/), not
// inside pi's managed agent dir (settings/trust/auth…): quota is a
// user-level consumption counter, and we deliberately do NOT follow
// PI_CODING_AGENT_DIR (an agent dir may point at sandbox/tmp — a counter
// should not wander). CONFIG_DIR_NAME honors a custom configDir.
function quotaPath(): string {
	return join(homedir(), CONFIG_DIR_NAME, "read-doc.json");
}
function monthKey(d = new Date()): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
/**
 * Local calendar date (YYYY-MM-DD). The quota month boundary is user-facing
 * (1k pages/month resets on the local month), so the local calendar — not
 * UTC — governs; monthKey() must stay on the same calendar (loadQuota
 * slices updatedAt with monthKey()).
 */
function dateKey(d = new Date()): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const fileQuota: QuotaStore = {
	async used(): Promise<number> {
		try {
			const raw = await readFile(quotaPath(), "utf-8");
			const j = JSON.parse(raw) as { quota?: { updatedAt?: string; used?: number } };
			if (!j.quota?.updatedAt || j.quota.updatedAt.slice(0, 7) !== monthKey()) return 0;
			return j.quota?.used ?? 0;
		} catch {
			return 0;
		}
	},
	async charge(pages: number): Promise<void> {
		try {
			const p = quotaPath();
			await mkdir(dirname(p), { recursive: true });
			const quota = { updatedAt: dateKey(), used: (await fileQuota.used()) + pages };
			await writeFile(p, JSON.stringify({ quota }, null, 2), "utf-8");
		} catch {}
	},
};

// ── The fallback chain ────────────────────────────────────────

/**
 * Run the chain:
 * 1. anydoc local (all office formats)
 * 2. `needsOcr` → hosted OCR, gated by the monthly quota (charged on success)
 * 3. `needsOcr` + pdf → local rapidocr
 * 4. otherwise the original error propagates (the caller adds the hint).
 */
export async function convertDocument(path: string, ext: string, deps: ConvertDeps): Promise<ConvertedDocument> {
	let md: string;
	try {
		md = await deps.toMarkdown(path);
	} catch (err) {
		if ((err as { code?: string })?.code !== "needsOcr") throw err;

		const used = await deps.quota.used();
		if (used < QUOTA_LIMIT) {
			try {
				const hosted = await deps.limit(() => deps.toMarkdown(path, { ocr: "hosted" }));
				const pages = Math.max(1, (err as { pages?: unknown[] })?.pages?.length ?? 1);
				await deps.quota.charge(pages);
				return { text: hosted, via: "anydoc:hosted" };
			} catch {
				// hosted failed → fall through to rapid
			}
		}
		if (ext === ".pdf") {
			const rapid = await deps.rapidOcr(path);
			if (rapid) return { text: rapid, via: "rapid" };
		}
		throw err;
	}
	return { text: md, via: "anydoc" };
}
