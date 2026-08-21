/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - UA: system default browser version → standard UA string (see ua.ts),
 *     cached per process.
 *   - Browser-like request headers (Accept: text/markdown content negotiation),
 *     timeout, SPA empty-body detection, error normalization (HTTP status →
 *     error field, not a throw).
 */

import { stashOverflow } from "@everyx/pi-ui/context.js";
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
/** For raw fetches: request the HTML source, not a negotiated markdown body. */
const ACCEPT_HTML = "text/html, application/xhtml+xml, application/xml;q=0.9, image/avif, image/webp, */*;q=0.8";

interface FetchPageResult {
	ok: boolean;
	status: number;
	contentType?: string;
	text?: string;
	error?: string;
}

/** Context cap + /tmp full-text stash — the shared primitive (pi-ui/context.ts).
 *  Budget is pi-bash parity: 2000 lines / 50KB, whichever hits first. Applies
 *  to converted Markdown and raw source alike. */
function capWithStash(text: string, url: string): { content: string; outputPath?: string } {
	const { text: capped, stashPath } = stashOverflow(text, url);
	return { content: capped, outputPath: stashPath };
}

/** Only HTML-family responses go through markdown extraction. */
function isHtmlContent(contentType: string): boolean {
	return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

/** Direct HTTP fetch with browser-like headers + timeout. */
async function fetchPage(url: string, ua: string, signal?: AbortSignal, preferHtml = false): Promise<FetchPageResult> {
	let response: Response;
	try {
		response = await fetchWithTimeout(
			url,
			{
				headers: {
					"User-Agent": ua,
					Accept: preferHtml ? ACCEPT_HTML : ACCEPT,
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
		// undici wraps connection-level failures as "fetch failed" with the
		// code on err.cause — surface it so callers can tell a server-side
		// reset (anti-bot / Cloudflare) from other network errors.
		const code = (err as { cause?: { code?: string } }).cause?.code;
		return { ok: false, status: 0, error: code ? `${message} (${code})` : message };
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

export interface WebFetchOptions {
	/** Return the raw source as-is instead of converted Markdown (HTML stays HTML). */
	raw?: boolean;
	signal?: AbortSignal;
}

/** Language tag for non-prose bodies — lets both the TUI (no mis-rendering)
 *  and the LLM (shape from the fence label) read JSON/XML/HTML correctly. */
function codeBlockLang(contentType: string): string | undefined {
	if (contentType.includes("html")) return "html";
	if (contentType.includes("json")) return "json";
	if (contentType.includes("xml")) return "xml";
	return undefined;
}

/** Wrap non-prose content in a fenced code block labelled by content type. */
function fenced(content: string, lang?: string): string {
	return lang ? `\`\`\`${lang}\n${content}\n\`\`\`` : content;
}

/** The web_fetch primitive. Returns { title, content } with error field on failure. */
export async function webFetch(url: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
	const { raw = false, signal } = options;
	if (!/^https?:\/\//i.test(url)) {
		return { title: "", content: "", error: `Unsupported URL: ${url} (only http/https)` };
	}

	const ua = await resolveUserAgent();
	// Site adapters rewrite content URLs (e.g. GitHub blob → raw); fall back
	// to the original URL when the rewrite target is unavailable.
	const targetUrl = adaptUrl(url) ?? url;
	// raw asks for the source, so prefer an HTML (not negotiated-markdown) body.
	let page = await fetchPage(targetUrl, ua, signal, raw);
	if (targetUrl !== url && (!page.ok || !page.text)) {
		page = await fetchPage(url, ua, signal, raw);
	}

	// Direct HTTP failure → normalized error.
	if (!page.ok) {
		return {
			title: "",
			content: "",
			error: page.error || `Failed to fetch ${url}`,
		};
	}

	// raw: return the source content as-is — HTML stays HTML (no markdown
	// conversion, no CSR rendering). Site URL rewrites still apply (that's a
	// URL-semantic rewrite, not a format transform). Non-prose bodies get a
	// fenced code block labelled by content type.
	if (raw) {
		const text = (page.text ?? "").trim();
		if (!text) return { title: "", content: "", error: "Empty response" };
		const { content, outputPath } = capWithStash(text, url);
		return { title: "", content: fenced(content, codeBlockLang(page.contentType ?? "")), outputPath };
	}

	// Non-HTML: the source is already readable — return it as-is (no markdown
	// conversion is possible). structurJSON/XML bodies get a fenced code block
	// so the caller never mistakes them for prose; markdown bodies keep their
	// frontmatter title and show as-is.
	if (page.contentType && !isHtmlContent(page.contentType)) {
		const text = (page.text ?? "").trim();
		if (!text) return { title: "", content: "", error: "Empty response" };
		const { content, outputPath } = capWithStash(text, url);
		const isMd = page.contentType.includes("text/markdown");
		return {
			title: isMd ? titleFromMarkdown(text) : "",
			content: isMd ? content : fenced(content, codeBlockLang(page.contentType)),
			outputPath,
		};
	}

	const extracted = htmlToMarkdown(page.text ?? "");
	if (extracted.markdown && !extracted.error) {
		const { content, outputPath } = capWithStash(extracted.markdown, url);
		return { title: extracted.title, content, outputPath };
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
					content: capWithStash(renderedExtract.markdown, url).content,
				};
			}
		}
	}

	// Non-CSR partial extraction: return what we have (status quo).
	if (extracted.markdown) {
		return { title: extracted.title, content: capWithStash(extracted.markdown, url).content };
	}

	const jsRendered = isLikelyJSRendered(page.text ?? "");
	return {
		title: "",
		content: "",
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
