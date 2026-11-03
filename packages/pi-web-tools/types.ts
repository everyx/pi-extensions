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

/** Search channels in fuse order. */
export type ChannelId = "tinyfish" | "exa" | "tavily" | "firecrawl";

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
}

/** A page renderer's output: the text and the real type of that text. */
export interface RenderedContent {
	text: string;
	/** The real type of the text (tinyfish: the markdown it was asked for).
	 *  The result card's contentType is this, verbatim (SPEC 诚实规则). */
	contentType: string;
}

/** What a renderer managed to do, and why not when it failed. The reason is a
 *  card diagnostic: a renderer that fails without saying why is how the last
 *  one died unnoticed (TinyFish started answering 401 and read as "no content"). */
export interface RenderOutcome {
	content: RenderedContent | null;
	/** Set when content is null — e.g. "HTTP 401", "empty markdown". */
	reason?: string;
}

/** One search channel (fuse member) — composed by search/channels.ts into
 *  fuse order, walked by search/fuse.ts. */
export interface SearchChannel {
	id: ChannelId;
	/** Environment gate — an unavailable channel is not a candidate. */
	available: () => boolean | Promise<boolean>;
	/** Capability gate — an available channel that cannot honor this
	 *  request's filters is skipped (SPEC: 能力缺失不静默，跳过而非降级). */
	supports: (params: WebSearchParams) => boolean;
	/** The search call — HTTP/CLI details live in the adapter. */
	search: (params: WebSearchParams, ctx: ChannelSearchContext) => Promise<SearchResultItem[]>;
}

/** web_search tool-result payload (`details.data`) — written by index.ts,
 *  rendered by views.ts, mirrored by preview.ts fixtures. */
export type SearchToolData = {
	results?: SearchResultItem[];
	channel?: ChannelId;
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
	/** Set exactly when the fetch was truncated — full text stashed on disk
	 *  (the expand view / read takes over). */
	outputPath?: string;
	/** Fuse renderer that delivered the content (absent on a direct fetch). */
	renderer?: string;
	/** Why the fuse ran, and what the renderers that did not answer said. */
	renderReason?: string;
	rendererFailures?: string[];
	/** Where the redirect chain ended (equal to the request when it did not move). */
	finalUrl?: string;
	/** Every hop, in order — the card shows the chain, the model gets one line. */
	redirects?: { from: string; to: string; status: number }[];
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
	/** Which fuse renderer produced this content, when one did (details only:
	 *  the model gets the text, the card says where it came from). */
	renderer?: string;
	/** Why the fuse ran at all — direct HTTP refused it, or the shell was CSR. */
	renderReason?: "http-failed" | "csr-shell";
	/** What each renderer said, in fuse order — diagnostics for the card.
	 *  A renderer that dies silently is how the last one went unnoticed. */
	rendererFailures?: string[];
	/** Where the redirect chain ended; equal to the request when nothing moved. */
	finalUrl?: string;
	/** Every hop, in order. The content states the last one; the card shows all. */
	redirects?: { from: string; to: string; status: number }[];
	error?: string;
}
