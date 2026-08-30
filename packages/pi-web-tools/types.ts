/**
 * pi-web-tools — shared types.
 *
 * The LLM-visible surface is exactly two primitives (web_search / web_fetch).
 * Everything else (channels, engines, routing) is internal — see SPEC.md.
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

/** Channels. "bsk" is the real-browser channel (BrowserSkill CLI). */
export type ChannelId = "exa" | "tavily" | "parallel" | "bsk";

/** Real-browser search engines (bsk channel). */
export type EngineId = "google" | "bing" | "baidu" | "yandex";

/** Capabilities a channel may or may not support (SPEC: 通道能力矩阵). */
export interface ChannelCapabilities {
	/** structured domain filtering (allowed/blocked_domains params) */
	domains: boolean;
	/** structured recency filter */
	recency: boolean;
	/** BCP-47 locale param support */
	locale: boolean;
}

/** Capabilities a web_search call actually requests. */
export interface RequestedCapabilities {
	domains: boolean;
	recency: boolean;
	locale: boolean;
}

export interface WebSearchParams {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	allowed_domains?: string[];
	blocked_domains?: string[];
	locale?: string;
	engine?: "auto" | EngineId;
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
	engine?: EngineId;
	locale?: string;
	count?: number;
	startedAt?: number;
	endedAt?: number;
};

/** web_fetch tool-result payload (`details.data`) — same triangle. */
export type FetchToolData = {
	title?: string;
	content?: string;
	contentType?: string;
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
	error?: string;
}
