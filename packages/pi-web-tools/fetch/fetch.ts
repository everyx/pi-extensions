/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - UA: bsk evaluate "navigator.userAgent" when BrowserSkill is connected
 *     (cached), else a hardcoded modern Chrome UA.
 *   - Browser-like request headers, timeout, SPA empty-body detection,
 *     error normalization (HTTP status → error field, not a throw).
 *   - Jina Reader (r.jina.ai) fallback when the direct fetch is blocked or
 *     yields nothing readable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchWithTimeout } from "../http.js";
import type { WebFetchResult } from "../types.js";
import { htmlToMarkdown, isLikelyJSRendered } from "./markdown.js";

const execFileAsync = promisify(execFile);

const FALLBACK_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

let cachedUserAgent: string | null = null;
let uaFetchInFlight: Promise<string> | null = null;

/** Resolve a real-browser UA via bsk evaluate (SPEC: UA 策略). */
export async function resolveUserAgent(): Promise<string> {
	if (cachedUserAgent) return cachedUserAgent;
	if (!uaFetchInFlight) {
		uaFetchInFlight = (async () => {
			try {
				const { stdout } = await execFileAsync("bsk", ["evaluate", "--json", "navigator.userAgent"], {
					timeout: 5_000,
					env: { ...process.env, NO_COLOR: "1" },
				});
				const parsed = JSON.parse(stdout) as { result?: unknown; value?: unknown };
				const ua =
					typeof parsed.result === "string" ? parsed.result : typeof parsed.value === "string" ? parsed.value : null;
				if (ua?.startsWith("Mozilla")) {
					cachedUserAgent = ua;
					return ua;
				}
			} catch {
				// fall through to hardcoded UA
			}
			return FALLBACK_UA;
		})();
	}
	const ua = await uaFetchInFlight;
	uaFetchInFlight = null;
	return ua;
}

interface FetchPageResult {
	ok: boolean;
	status: number;
	contentType?: string;
	text?: string;
	error?: string;
}

/** Direct HTTP fetch with browser-like headers + timeout. */
async function fetchPage(url: string, ua: string, signal?: AbortSignal): Promise<FetchPageResult> {
	let response: Response;
	try {
		response = await fetchWithTimeout(
			url,
			{
				headers: {
					"User-Agent": ua,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Cache-Control": "no-cache",
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "none",
					"Upgrade-Insecure-Requests": "1",
				},
			},
			{ signal, timeoutMs: DEFAULT_TIMEOUT_MS },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 0, error: message };
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			contentType,
			error: `HTTP ${response.status}: ${response.statusText}`,
		};
	}
	if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
		const body = await response.text().catch(() => "");
		// Non-HTML (plain text/JSON): return as-is.
		if (
			!contentType.includes("image/") &&
			!contentType.includes("audio/") &&
			!contentType.includes("video/") &&
			!contentType.includes("application/octet-stream")
		) {
			return { ok: true, status: response.status, contentType, text: body };
		}
		return {
			ok: false,
			status: response.status,
			contentType,
			error: `Unsupported content type: ${contentType.split(";")[0]}`,
		};
	}

	const text = await response.text();
	return { ok: true, status: response.status, contentType, text };
}

/** Jina Reader fallback (extract as Markdown server-side). */
async function fetchViaJina(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
	let response: Response;
	try {
		response = await fetchWithTimeout(
			`${JINA_READER_BASE}${encodeURIComponent(url)}`,
			{ headers: { Accept: "text/markdown" } },
			{ signal, timeoutMs: JINA_TIMEOUT_MS },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { title: "", markdown: "", error: `Jina fallback failed: ${message}` };
	}
	if (!response.ok) {
		return { title: "", markdown: "", error: `HTTP ${response.status}: ${response.statusText} (Jina fallback)` };
	}
	const markdown = (await response.text()).trim();
	if (markdown.length < 40 || markdown.startsWith("Loading...") || markdown.startsWith("Please enable JavaScript")) {
		return { title: "", markdown: "", error: "No readable content (Jina fallback)" };
	}
	const firstLine =
		markdown
			.split("\n")[0]
			?.replace(/^#+\s*/, "")
			.trim() ?? "";
	return { title: firstLine.slice(0, 200), markdown };
}

/** The web_fetch primitive. Returns { title, markdown } with error field on failure. */
export async function webFetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
	if (!/^https?:\/\//i.test(url)) {
		return { title: "", markdown: "", error: `Unsupported URL: ${url} (only http/https)` };
	}

	const ua = await resolveUserAgent();
	const page = await fetchPage(url, ua, signal);

	// Direct HTTP failure → Jina fallback, then error.
	if (!page.ok) {
		const jina = await fetchViaJina(url, signal);
		if (jina.markdown) return jina;
		return {
			title: "",
			markdown: "",
			error: page.error || `Failed to fetch ${url}`,
		};
	}

	// Non-HTML text returned as-is.
	if (
		page.contentType &&
		!page.contentType.includes("text/html") &&
		!page.contentType.includes("application/xhtml+xml")
	) {
		const text = (page.text ?? "").trim();
		return text
			? { title: firstLineAsTitle(text), markdown: text.slice(0, 50_000) }
			: { title: "", markdown: "", error: "Empty response" };
	}

	const extracted = htmlToMarkdown(page.text ?? "");
	if (extracted.markdown) {
		return { title: extracted.title, markdown: extracted.markdown.slice(0, 50_000) };
	}

	// Readability yielded nothing readable (SPA or JS-rendered) → Jina fallback.
	const jina = await fetchViaJina(url, signal);
	if (jina.markdown) return jina;

	const jsRendered = isLikelyJSRendered(page.text ?? "");
	return {
		title: "",
		markdown: "",
		error: jsRendered ? "(no readable content) — page appears to be JavaScript-rendered" : "(no readable content)",
	};
}

function firstLineAsTitle(text: string): string {
	return text.split("\n")[0]?.trim().slice(0, 200) ?? "";
}
