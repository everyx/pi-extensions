/**
 * pi-web-tools — shared types.
 *
 * The LLM-visible surface is exactly two primitives (web_search / web_fetch).
 * Everything else (channels, routing) is internal — see README.
 */

export interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	/** Relative page age when the channel reports one ("about 3 hours ago"). */
	pageAge?: string;
	/** Author when the channel reports one. */
	author?: string;
}

/** Search channels in fuse order — api providers first, the real-browser
 *  channel (BrowserSkill CLI) last as the no-key fuse. */
export type ChannelId = "tinyfish" | "exa" | "tavily" | "firecrawl" | "bsk";

/** Real-browser engines for the bsk fuse — picked from the request's locale
 *  (zh → baidu, else google). No system-locale or config input. */
export type EngineId = "google" | "baidu";

export interface WebSearchParams {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	allowed_domains?: string[];
	blocked_domains?: string[];
	/** BCP-47 ("zh-CN") — prefer this language/region. Best-effort: each
	 *  channel maps it to its native market/language boost; absent → the
	 *  query's language leads. */
	locale?: string;
}

export interface ChannelSearchContext {
	/** AbortSignal from the tool call. */
	signal?: AbortSignal;
	/** Timeout budget for the whole channel attempt (ms). */
	timeoutMs?: number;
}

/** web_search tool-result payload (`details.data`) — written by index.ts,
 *  rendered by views.ts, mirrored by preview.ts fixtures. */
export type SearchToolData = {
	results?: SearchResultItem[];
	channel?: ChannelId;
	/** Set only when the bsk fuse served the search. */
	engine?: EngineId;
	locale?: string;
	count?: number;
	startedAt?: number;
	endedAt?: number;
};

/** web_fetch tool-result payload (`details.data`) — same triangle. */
export type FetchToolData = {
	title?: string;
	/** FULL fetched text for the expanded view (ctrl+o) — UI-only channel;
	 *  the LLM-visible text is the capped preview in the tool `content`. */
	content?: string;
	contentType?: string;
	/** Set exactly when the fetch was truncated — the collapsed card shows a
	 *  one-line expand hint on it (read-like header-only folding). */
	outputPath?: string;
	startedAt?: number;
	endedAt?: number;
};

/** web_fetch result. `content` is converted Markdown, the source verbatim,
 *  or a delivery marker (truncation pointer, not-inlined stash path, image
 *  note); error carries HTTP status. */
export interface WebFetchResult {
	title: string;
	/** Content — Markdown, verbatim source, or a delivery marker (see type doc). Never decorated. */
	content: string;
	/** Response Content-Type header, verbatim (e.g. "image/svg+xml; charset=utf-8"). */
	contentType?: string;
	/** Decoded image payload (auto-resized into the multimodal budget) when the response was an image. */
	image?: { data: string; mimeType: string };
	/** /tmp path of the full text when content was truncated; the LLM can read it. */
	outputPath?: string;
	/** Full fetched text before the LLM-side cap — feeds the UI expanded view
	 *  (details channel, never the LLM context); set when the cap bit in. */
	fullContent?: string;
	error?: string;
}
