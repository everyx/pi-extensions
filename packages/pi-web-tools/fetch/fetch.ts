/**
 * pi-web-tools — web_fetch core (SPEC: web_fetch 行为规格).
 *
 *   - Direct fetch: Node's fetch in-process (proxy-aware); the rendering fuse
 *     (firecrawl → tinyfish) covers anti-bot and CSR pages.
 *   - timeout, SPA empty-body detection, error normalization (HTTP status →
 *     error field, not a throw).
 */

import { formatDimensionNote, formatSize, resizeImage } from "@earendil-works/pi-coding-agent";
import { stashOverflow } from "@everyx/pi-ui/context.js";
import type { RenderOutcome, WebFetchResult } from "../types.js";
import { fetchWithFirecrawl } from "./api/firecrawl-fetch.js";
import { directFetch } from "./api/http-fetch.js";
import { fetchWithTinyfish, tinyfishFetchKey } from "./api/tinyfish-fetch.js";
import { githubRawUrl } from "./github.js";
import { htmlToMarkdown, isLikelyJSRendered } from "./markdown.js";

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
/** The whole rendering fuse gets one deadline; each renderer takes what is
 *  left of it. Without a shared budget three slow vendors in a row would turn
 *  one failed fetch into minutes of waiting, and the caller cannot cancel
 *  its way out of that. */
const RENDER_BUDGET_MS = 45_000;
/** Below this there is no point starting another renderer. */
const RENDER_FLOOR_MS = 5_000;

/** One rendering provider. Order is the fuse order: the cheaper, more
 *  available one first. */
interface Renderer {
	id: string;
	/** Rendering needs a key that is not configured — skip, do not try. */
	available: () => boolean;
	render: (url: string, deadline: number, signal?: AbortSignal) => Promise<RenderOutcome>;
}

const RENDERERS: Renderer[] = [
	// Keyless (verified 2026-11-03): the only renderer that works with no key
	// at all, so it goes first.
	{ id: "firecrawl", available: () => true, render: fetchWithFirecrawl },
	// Better rendering, but keyed since TinyFish started requiring a key.
	{ id: "tinyfish", available: () => tinyfishFetchKey() !== null, render: fetchWithTinyfish },
];

/**
 * Whether rendering can plausibly help with a failed direct fetch.
 *
 * The fuse exists for pages plain HTTP cannot deliver: anti-bot walls (403),
 * transient server failures, CSR shells. It cannot resurrect a page that does
 * not exist (404/410), and it cannot pay for one (402), outrun a quota (429),
 * or bypass a legal block (451). Firing the fuse there only spends time and
 * someone else's bandwidth to arrive at the same answer.
 */
export function renderMayHelp(status: number): boolean {
	if (status === 0) return true; // network failure / no status at all
	if (status === 404 || status === 410) return false; // the page is not there
	if (status === 401 || status === 402 || status === 407) return false; // payment / auth
	if (status === 429) return false; // quota — a renderer only spends more
	if (status === 451) return false; // unavailable for legal reasons
	return true;
}

/** Render through the fuse, reporting which renderer produced the text and
 *  what the others said. A renderer that fails silently is how the previous
 *  one died unnoticed (TinyFish began answering 401 and we called it "no
 *  content"), so every refusal is recorded for the card even though the model
 *  only needs the text or the honest error. */
async function fuseRender(
	url: string,
	signal?: AbortSignal,
	reason: "http-failed" | "csr-shell" = "http-failed",
): Promise<{ result: WebFetchResult | null; failures: string[] }> {
	const deadline = Date.now() + RENDER_BUDGET_MS;
	const failures: string[] = [];
	for (const renderer of RENDERERS) {
		if (!renderer.available()) {
			failures.push(`${renderer.id}: no credentials`);
			continue;
		}
		if (signal?.aborted) break;
		const remaining = deadline - Date.now();
		if (remaining < RENDER_FLOOR_MS) {
			failures.push(`${renderer.id}: skipped, fuse budget spent`);
			break;
		}
		const outcome = await renderer.render(url, deadline, signal);
		if (!outcome.content) {
			failures.push(`${renderer.id}: ${outcome.reason ?? "no content"}`);
			continue;
		}
		const rendered = outcome.content;
		const { text: content, stashPath } = stashOverflow(rendered.text, url);
		return {
			result: {
				title: firstLineAsTitle(rendered.text),
				content: previewWithPointer(content, stashPath),
				// The renderer self-reports its output type — no fabrication.
				contentType: rendered.contentType,
				outputPath: stashPath,
				fullContent: rendered.text,
				renderer: renderer.id,
				renderReason: reason,
				// A provider that failed first is exactly the context someone
				// debugging a slow or partial fetch wants; dropping it on success
				// would keep the diagnosis for the case nobody investigates.
				rendererFailures: failures,
			},
			failures,
		};
	}
	return { result: null, failures };
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

/** Direct HTTP GET, one transport: Node's fetch in-process, proxy-aware.
 *  Anti-bot and CSR pages advance to the rendering fuse. No
 *  content-type gating — every gate is a policy decision that limits the
 *  caller. Text passes through readable; true binaries lossy-decode into
 *  recognizable noise (the contentType field says what it is); budget stays
 *  bounded by the stash cap downstream. */
async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchPageResult> {
	const raw = await directFetch(url, { signal, timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: MAX_DOWNLOAD_BYTES });
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

	// The GitHub adapter rewrites blob URLs to raw content; fall back to the
	// original URL when the rewrite target is unavailable.
	const targetUrl = githubRawUrl(url) ?? url;
	// raw asks for the source, so prefer an HTML (not negotiated-markdown) body.
	let page = await fetchPage(targetUrl, signal);
	if (targetUrl !== url && (!page.ok || !page.text)) {
		page = await fetchPage(url, signal);
	}

	// Direct HTTP failure → normalized error. The classifier decides whether a
	// renderer could plausibly do better; when it cannot, spending the fuse's
	// budget would only delay the same answer.
	if (!page.ok) {
		// A cancelled call is not a page we failed to render. Entering the fuse
		// here would queue behind a rate limiter for work the caller gave up on.
		if (signal?.aborted) {
			return { title: "", content: "", error: page.error || "fetch aborted" };
		}
		const fuse = renderMayHelp(page.status) ? await fuseRender(url, signal, "http-failed") : undefined;
		if (fuse?.result) return fuse.result;
		return {
			title: "",
			content: "",
			error: page.error || `Failed to fetch ${url}`,
			rendererFailures: fuse?.failures,
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
	// no decoration. The GitHub URL rewrite still applies (URL semantics, not
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
	// Render it remotely so the LLM gets real content instead of a placeholder
	// (tinyfish fetch). Local headless rendering was removed earlier: same
	// capability, one implementation (SPEC).
	// Keep what the fuse said when it could not render: both returns below are
	// outcomes of that failure, and dropping the reasons here is what made the
	// diagnosis reach only one of the fuse's two entry points.
	let rendererFailures: string[] | undefined;
	if (isLikelyJSRendered(page.text ?? "")) {
		const fuse = await fuseRender(url, signal, "csr-shell");
		if (fuse.result) return fuse.result;
		rendererFailures = fuse.failures;
	}

	// Partial extraction after a failed render: return what we have, plus what
	// the fuse said about why it could not do better.
	if (extracted.markdown) {
		const { text: content, stashPath } = stashOverflow(extracted.markdown, url);
		return {
			title: extracted.title,
			content: previewWithPointer(content, stashPath),
			contentType: page.contentType || undefined,
			outputPath: stashPath,
			fullContent: extracted.markdown,
			rendererFailures,
		};
	}

	const jsRendered = isLikelyJSRendered(page.text ?? "");
	return {
		title: "",
		content: "",
		error: jsRendered ? "(no readable content) — page appears to be JavaScript-rendered" : "(no readable content)",
		rendererFailures,
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
