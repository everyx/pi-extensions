/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - UA: system default browser version → standard UA string (see ua.ts),
 *     cached per process.
 *   - Browser-like request headers (Accept: text/markdown content negotiation),
 *     timeout, SPA empty-body detection, error normalization (HTTP status →
 *     error field, not a throw).
 */

import { formatDimensionNote, formatSize, resizeImage } from "@earendil-works/pi-coding-agent";
import { stashOverflow } from "@everyx/pi-ui/context.js";
import { fetchWithTimeout } from "../http.js";
import type { WebFetchResult } from "../types.js";
import { renderPage } from "./headless.js";
import { htmlToMarkdown, isLikelyJSRendered } from "./markdown.js";
import { adaptUrl } from "./sites/index.js";
import { resolveUserAgent } from "./ua.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Accept header: prefer Markdown for Agents (content negotiation, Cloudflare).
 *  No image/avif: our decoder (Photon) cannot decode AVIF — asking for it
 *  would negotiate images we then degrade to noise (verified empirically);
 *  webp/jpeg/png all decode. */
const ACCEPT = "text/markdown, text/html, application/xhtml+xml, application/xml;q=0.9, image/webp, */*;q=0.8";
/** For raw fetches: request the HTML source, not a negotiated markdown body. */
const ACCEPT_HTML = "text/html, application/xhtml+xml, application/xml;q=0.9, image/webp, */*;q=0.8";

/** Host-memory physics, not policy: the download buffer cap. The body is read
 *  as a stream with a running count (Content-Length is untrusted — chunked
 *  responses have none); past the cap the stream is abandoned and nothing
 *  further enters memory. Set well above the image budget so every
 *  resizable image still fits. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

async function readBodyCapped(response: Response): Promise<Uint8Array | null> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_DOWNLOAD_BYTES) {
			void reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

interface FetchPageResult {
	ok: boolean;
	status: number;
	contentType?: string;
	text?: string;
	/** Set for image responses that fit the multimodal budget (auto-resized). */
	image?: { data: string; mimeType: string; note?: string };
	/** Body exceeded MAX_DOWNLOAD_BYTES and was abandoned unread. */
	tooLarge?: boolean;
	error?: string;
}

/** Images are their own deliverable — except SVG, which IS text (XML). */
function isImageContent(contentType: string): boolean {
	return contentType.startsWith("image/") && !contentType.includes("svg+xml");
}

/** Two consumption models, mapped from pi's own tools (bash / read):
 *  - Web-page markdown = "read an article" — capped preview + pointer (the
 *    LLM judges relevance from the preview, reads on via the path).
 *  - Everything else = "consume an artifact" — the LLM came for this exact
 *    file, a lossy preview is only duplicate cost. On overflow the full text
 *    is stashed and the result points at it; the read tool's offset/limit
 *    paging takes over from there. Binaries never enter context as noise. */
function previewWithPointer(content: string, stashPath?: string): string {
	return stashPath ? `${content}\n\n(output truncated — full output: ${stashPath})` : content;
}

function notInlined(bytes: number, contentType: string | undefined, stashPath: string): string {
	const mime = contentType?.split(";")[0].trim();
	return `(content not inlined — ${formatSize(bytes)}${mime ? `, ${mime}` : ""})\nfull output: ${stashPath}`;
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
	// No content-type gating — every gate is a policy decision that limits the
	// caller. Text passes through readable; true binaries lossy-decode into
	// recognizable noise (the contentType field says what it is); what the
	// caller does with either is its call. Budget stays bounded by the stash
	// cap downstream.
	const bytes = await readBodyCapped(response);
	if (!bytes) {
		return { ok: true, status: response.status, contentType, tooLarge: true };
	}
	if (isImageContent(contentType)) {
		// The TUI renders image blocks at cell size (no byte limit) and the
		// model consumes them multimodally — so route images there. resizeImage
		// shrinks/quality-steps anything past the ~4.5MB base64 budget; null
		// means undecodable — fall through to honest noise like any binary.
		const mime = contentType.split(";")[0].trim();
		const resized = await resizeImage(new Uint8Array(bytes), mime).catch(() => null);
		if (resized) {
			return {
				ok: true,
				status: response.status,
				contentType,
				image: { data: resized.data, mimeType: resized.mimeType, note: formatDimensionNote(resized) },
			};
		}
	}
	const text = new TextDecoder().decode(bytes);
	return { ok: true, status: response.status, contentType, text };
}

export interface WebFetchOptions {
	/** Return the raw source as-is instead of converted Markdown (HTML stays HTML). */
	raw?: boolean;
	signal?: AbortSignal;
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

	// Over the download cap: the body was abandoned mid-stream, so there is
	// nothing to convert, stash, or decode — report the fact with metadata.
	if (page.tooLarge) {
		const mime = page.contentType?.split(";")[0].trim();
		return {
			title: "",
			content: `(content not buffered — exceeds ${formatSize(MAX_DOWNLOAD_BYTES)} download cap${mime ? `, ${mime}` : ""})`,
			contentType: page.contentType || undefined,
		};
	}

	// The source IS the deliverable — raw mode, or any non-HTML body (SVG,
	// JSON, CSV, YAML… all just text). Return it verbatim: no transformation,
	// no decoration. Site URL rewrites still apply (URL semantics, not
	// format). Only the title heuristic differs: Markdown-for-Agents bodies
	// carry their title in the frontmatter — never parsed in raw mode (raw =
	// pure source). On overflow the full text is stashed and pointed at, not
	// previewed: a deliberate fetch has no relevance question left to answer.
	if (raw || !(page.contentType && isHtmlContent(page.contentType))) {
		if (page.image) {
			const note = page.image.note;
			return {
				title: "",
				content: `Image fetched: ${page.image.mimeType}${note ? ` — ${note}` : ""}`,
				contentType: page.contentType,
				image: { data: page.image.data, mimeType: page.image.mimeType },
			};
		}
		const text = (page.text ?? "").trim();
		if (!text) return { title: "", content: "", error: "Empty response" };
		const contentType = page.contentType || undefined;
		const isMd = Boolean(!raw && page.contentType?.includes("text/markdown"));
		const { text: capped, stashPath } = stashOverflow(text, url);
		return {
			title: isMd ? titleFromMarkdown(text) : "",
			content: stashPath ? notInlined(Buffer.byteLength(text, "utf8"), contentType, stashPath) : capped,
			contentType,
			outputPath: stashPath,
		};
	}

	const extracted = htmlToMarkdown(page.text ?? "");
	if (extracted.markdown && !extracted.error) {
		const { text: content, stashPath } = stashOverflow(extracted.markdown, url);
		return {
			title: extracted.title,
			content: previewWithPointer(content, stashPath),
			contentType: page.contentType || undefined,
			outputPath: stashPath,
		};
	}

	// Extraction failed or was incomplete + JS framework markers → CSR page.
	// Render it locally so the LLM gets real content instead of a placeholder.
	if (isLikelyJSRendered(page.text ?? "")) {
		const rendered = await renderPage(url);
		if (rendered) {
			const renderedExtract = htmlToMarkdown(rendered);
			if (renderedExtract.markdown && !renderedExtract.error) {
				const { text: content, stashPath } = stashOverflow(renderedExtract.markdown, url);
				return {
					title: renderedExtract.title,
					content: previewWithPointer(content, stashPath),
					contentType: page.contentType || undefined,
					outputPath: stashPath,
				};
			}
		}
	}

	// Non-CSR partial extraction: return what we have (status quo).
	if (extracted.markdown) {
		const { text: content, stashPath } = stashOverflow(extracted.markdown, url);
		return {
			title: extracted.title,
			content: previewWithPointer(content, stashPath),
			contentType: page.contentType || undefined,
			outputPath: stashPath,
		};
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
