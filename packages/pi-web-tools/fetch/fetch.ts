/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - Direct fetch: the system curl CLI (identity = real curl, nothing
 *     mimicked), shallow curl-UA fallback on curl-less systems; fuse
 *     renderers (tinyfish fetch → bsk) cover anti-bot and CSR pages.
 *   - timeout, SPA empty-body detection, error normalization (HTTP status →
 *     error field, not a throw).
 */

import { formatDimensionNote, formatSize, resizeImage } from "@earendil-works/pi-coding-agent";
import { stashOverflow } from "@everyx/pi-ui/context.js";
import { fetchUrlWithBsk } from "../search/browser.js";
import type { WebFetchResult } from "../types.js";
import { curlFetch } from "./api/curl-fetch.js";
import { fetchWithTinyfish } from "./api/tinyfish-fetch.js";
import { htmlToMarkdown, isLikelyJSRendered } from "./markdown.js";
import { adaptUrl } from "./sites/index.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Host-memory physics, not policy: the download buffer cap. The body is read
 *  as a stream with a running count (Content-Length is untrusted — chunked
 *  responses have none); past the cap the stream is abandoned and nothing
 *  further enters memory. Set well above the image budget so every
 *  resizable image still fits. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

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

/** Shared tail for both transport tiers: bytes → image/text result, honest
 *  on every edge (never fabricates content from a failed fetch). */
async function finishPage(
	status: number,
	contentType: string,
	bytes: Uint8Array | null | undefined,
	tooLarge: boolean,
	error?: string,
): Promise<FetchPageResult> {
	if (error) return { ok: false, status, contentType, error };
	if (tooLarge) return { ok: true, status, contentType, tooLarge: true };
	if (!bytes || bytes.length === 0) return { ok: false, status: 0, contentType, error: "Empty response" };
	if (isImageContent(contentType)) {
		// The TUI renders image blocks at cell size (no byte limit) and the
		// model consumes them multimodally — so route images there. resizeImage
		// shrinks/quality-steps anything past the ~4.5MB base64 budget; null
		// means undecodable — fall through to honest noise like any binary.
		const mime = contentType.split(";")[0].trim();
		const resized = await resizeImage(bytes, mime).catch(() => null);
		if (resized) {
			return {
				ok: true,
				status,
				contentType,
				image: { data: resized.data, mimeType: resized.mimeType, note: formatDimensionNote(resized) },
			};
		}
	}
	return { ok: true, status, contentType, text: new TextDecoder().decode(bytes) };
}

/** Two consumption models, mapped from pi's own tools (bash / read):
 *  - Web-page markdown = "read an article" — capped preview + pointer (the
 *    LLM judges relevance from the preview, reads on via the path).
 *  - Everything else = "consume an artifact" — the LLM came for this exact
 *    file, a lossy preview is only duplicate cost. On overflow the full text
 *    is stashed and the result points at it; the read tool's offset/limit
 *    paging takes over from there. Binaries never enter context as noise. */
/** Fuse renderers for the web_fetch chain (SPEC: GET → tinyfish fetch → bsk).
 *  Both render in a real browser and return clean text — results flow through
 *  the same stash/preview path as locally extracted markdown. Returns null
 *  when every renderer is unavailable or failed (caller shows its own error). */
async function fuseRender(url: string, signal?: AbortSignal): Promise<WebFetchResult | null> {
	const candidates: Array<() => Promise<string | null>> = [
		() => fetchWithTinyfish(url, signal),
		() => fetchUrlWithBsk(url),
	];
	for (const render of candidates) {
		const text = await render();
		if (text) {
			const { text: content, stashPath } = stashOverflow(text, url);
			return {
				title: firstLineAsTitle(text),
				content: previewWithPointer(content, stashPath),
				contentType: "text/markdown",
				outputPath: stashPath,
				fullContent: text,
			};
		}
	}
	return null;
}

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

/** Direct HTTP GET, one honest transport: the system curl (native TLS/UA/HTTP
 *  version — zero mimicry; a human-usage pattern doesn't need it), with a
 *  pinned-identity shallow fallback when curl is absent. Anti-bot and CSR
 *  pages advance to the fuse renderers (tinyfish fetch → bsk). No
 *  content-type gating — every gate is a policy decision that limits the
 *  caller. Text passes through readable; true binaries lossy-decode into
 *  recognizable noise (the contentType field says what it is); budget stays
 *  bounded by the stash cap downstream. */
async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchPageResult> {
	const raw = await curlFetch(url, { signal, timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: MAX_DOWNLOAD_BYTES });
	if (raw.ok) {
		return finishPage(raw.status, raw.contentType, raw.bytes ?? null, raw.tooLarge);
	}
	return {
		ok: false,
		status: raw.status,
		contentType: raw.contentType,
		error: raw.error ?? `Failed to fetch ${url}`,
	};
}

interface WebFetchOptions {
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

	// Site adapters rewrite content URLs (e.g. GitHub blob → raw); fall back
	// to the original URL when the rewrite target is unavailable.
	const targetUrl = adaptUrl(url) ?? url;
	// raw asks for the source, so prefer an HTML (not negotiated-markdown) body.
	let page = await fetchPage(targetUrl, signal);
	if (targetUrl !== url && (!page.ok || !page.text)) {
		page = await fetchPage(url, signal);
	}

	// Direct HTTP failure → normalized error. 404/410 mean the page genuinely
	// does not exist — a renderer cannot resurrect it. Everything else
	// (anti-bot walls, transient 5xx, network failure) advances the fuse.
	if (!page.ok) {
		if (page.status !== 404 && page.status !== 410) {
			const rendered = await fuseRender(url, signal);
			if (rendered) return rendered;
		}
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
			fullContent: text,
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
			fullContent: extracted.markdown,
		};
	}

	// Extraction failed or was incomplete + JS framework markers → CSR page.
	// Render it in a real browser so the LLM gets real content instead of a
	// placeholder — remotely first (tinyfish fetch), then the user's own
	// browser session (bsk). Local headless rendering was removed: same
	// capability, one implementation (SPEC).
	if (isLikelyJSRendered(page.text ?? "")) {
		const rendered = await fuseRender(url, signal);
		if (rendered) return rendered;
	}

	// Non-CSR partial extraction: return what we have (status quo).
	if (extracted.markdown) {
		const { text: content, stashPath } = stashOverflow(extracted.markdown, url);
		return {
			title: extracted.title,
			content: previewWithPointer(content, stashPath),
			contentType: page.contentType || undefined,
			outputPath: stashPath,
			fullContent: extracted.markdown,
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
