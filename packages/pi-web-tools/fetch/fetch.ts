/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - UA: system default browser version → standard UA string (see ua.ts),
 *     cached per process.
 *   - Browser-like request headers (Accept: text/markdown content negotiation),
 *     timeout, SPA empty-body detection, error normalization (HTTP status →
 *     error field, not a throw).
 */

import { fetchWithTimeout } from "../http.js";
import type { WebFetchResult } from "../types.js";
import { htmlToMarkdown, isLikelyJSRendered } from "./markdown.js";
import { resolveUserAgent } from "./ua.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Accept header: prefer Markdown for Agents (content negotiation, Cloudflare). */
const ACCEPT =
	"text/markdown, text/html, application/xhtml+xml, application/xml;q=0.9, image/avif, image/webp, */*;q=0.8";

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
					Accept: ACCEPT,
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

/** The web_fetch primitive. Returns { title, markdown } with error field on failure. */
export async function webFetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
	if (!/^https?:\/\//i.test(url)) {
		return { title: "", markdown: "", error: `Unsupported URL: ${url} (only http/https)` };
	}

	const ua = await resolveUserAgent();
	const page = await fetchPage(url, ua, signal);

	// Direct HTTP failure → normalized error.
	if (!page.ok) {
		return {
			title: "",
			markdown: "",
			error: page.error || `Failed to fetch ${url}`,
		};
	}

	// Non-HTML text returned as-is. A text/markdown body (Markdown for
	// Agents content negotiation) is already the target format — extract the
	// title from its frontmatter.
	if (
		page.contentType &&
		!page.contentType.includes("text/html") &&
		!page.contentType.includes("application/xhtml+xml")
	) {
		const text = (page.text ?? "").trim();
		if (!text) return { title: "", markdown: "", error: "Empty response" };
		return page.contentType.includes("text/markdown")
			? { title: titleFromMarkdown(text), markdown: text.slice(0, 50_000) }
			: { title: firstLineAsTitle(text), markdown: text.slice(0, 50_000) };
	}

	const extracted = htmlToMarkdown(page.text ?? "");
	if (extracted.markdown) {
		return { title: extracted.title, markdown: extracted.markdown.slice(0, 50_000) };
	}

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

/** Title from a Markdown-for-Agents body: YAML frontmatter `title:` field. */
function titleFromMarkdown(markdown: string): string {
	const m = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
	if (m) {
		const t = m[0].match(/^title:\s*(.+)$/m);
		if (t) return t[1].trim().slice(0, 200);
	}
	return firstLineAsTitle(markdown);
}
