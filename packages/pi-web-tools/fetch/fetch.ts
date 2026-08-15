/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - UA: system default browser version → standard UA string (see ua.ts),
 *     cached per process.
 *   - Browser-like request headers (Accept: text/markdown content negotiation),
 *     timeout, SPA empty-body detection, error normalization (HTTP status →
 *     error field, not a throw).
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { fetchWithTimeout } from "../http.js";
import type { WebFetchResult } from "../types.js";
import { renderPage } from "./headless.js";
import { htmlToMarkdown, isLikelyJSRendered } from "./markdown.js";
import { adaptUrl } from "./sites/index.js";
import { resolveUserAgent } from "./ua.js";

const DEFAULT_TIMEOUT_MS = 30_000;

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

/** Context cap for fetched content: 50KB of UTF-8 bytes — pi truncateHead
 *  parity. LLM token budgets track bytes, not char counts, so byte-capping
 *  keeps Chinese/emoji-heavy pages inside the same budget as ASCII ones. */
const MAX_MARKDOWN_BYTES = 50_000;

/** Cap fetched markdown to the context budget, keeping the head. */
export function capMarkdown(text: string): string {
	return truncateHead(text, { maxBytes: MAX_MARKDOWN_BYTES }).content;
}

/**
 * When fetched content exceeds the context cap, stash the full text in /tmp
 * so the LLM can read it on demand — the result carries an inline marker with
 * the path (one field, self-describing), like pi-subagent's full-output file.
 */
function stashIfTruncated(text: string, url: string): string | undefined {
	if (Buffer.byteLength(text, "utf8") <= MAX_MARKDOWN_BYTES) return undefined;
	const key = createHash("sha1").update(url).digest("hex").slice(0, 8);
	const file = `/tmp/pi-web-fetch-${key}.txt`;
	try {
		writeFileSync(file, text, "utf8");
		return file;
	} catch {
		return undefined; // best-effort: never break the fetch
	}
}

/** Only HTML-family responses go through markdown extraction. */
function isHtmlContent(contentType: string): boolean {
	return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
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
	if (!isHtmlContent(contentType)) {
		const body = await response.text().catch(() => "");
		// Non-HTML (plain text/JSON/markdown): return as-is.
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
	// Site adapters rewrite content URLs (e.g. GitHub blob → raw); fall back
	// to the original URL when the rewrite target is unavailable.
	const targetUrl = adaptUrl(url) ?? url;
	let page = await fetchPage(targetUrl, ua, signal);
	if (targetUrl !== url && (!page.ok || !page.text)) {
		page = await fetchPage(url, ua, signal);
	}

	// Direct HTTP failure → normalized error.
	if (!page.ok) {
		return {
			title: "",
			markdown: "",
			error: page.error || `Failed to fetch ${url}`,
		};
	}

	// Non-HTML responses return raw content as-is. text/markdown (negotiated)
	// is already the target format — title from its frontmatter; other text
	// bodies (JSON/XML/plain) have no title of their own.
	if (page.contentType && !isHtmlContent(page.contentType)) {
		const text = (page.text ?? "").trim();
		if (!text) return { title: "", markdown: "", error: "Empty response" };
		const outputPath = stashIfTruncated(text, url);
		return page.contentType.includes("text/markdown")
			? { title: titleFromMarkdown(text), markdown: capMarkdown(text), outputPath }
			: { title: "", markdown: capMarkdown(text), outputPath };
	}

	const extracted = htmlToMarkdown(page.text ?? "");
	if (extracted.markdown && !extracted.error) {
		const outputPath = stashIfTruncated(extracted.markdown, url);
		return { title: extracted.title, markdown: capMarkdown(extracted.markdown), outputPath };
	}

	// Extraction failed or was incomplete + JS framework markers → CSR page.
	// Render it locally so the LLM gets real content instead of a placeholder.
	if (isLikelyJSRendered(page.text ?? "")) {
		const rendered = await renderPage(url);
		if (rendered) {
			const renderedExtract = htmlToMarkdown(rendered);
			if (renderedExtract.markdown && !renderedExtract.error) {
				return {
					title: renderedExtract.title,
					markdown: capMarkdown(renderedExtract.markdown),
				};
			}
		}
	}

	// Non-CSR partial extraction: return what we have (status quo).
	if (extracted.markdown) {
		return { title: extracted.title, markdown: capMarkdown(extracted.markdown) };
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
		// Frontmatter present: title comes only from its title field — never
		// guess from the first line (that would yield "---").
		return (
			m[0]
				.match(/^title:\s*(.+)$/m)?.[1]
				?.trim()
				.slice(0, 200) ?? ""
		);
	}
	return firstLineAsTitle(markdown);
}
