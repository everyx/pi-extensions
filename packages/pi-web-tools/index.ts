/**
 * pi-web-tools — extension entry: registers web_search + web_fetch.
 *
 * web_search routes across HTTP search providers in fuse order
 * (tinyfish → exa → tavily → firecrawl) and falls through on failure; the
 * real-browser channel (bsk) is the last-resort fuse, not an equal peer.
 * Availability is environment-driven (key presence / bsk CLI), never
 * configured. The LLM sees results or a terse error; channel echo,
 * hints and diagnostics live in details (UI-visible). SPEC.md is the doc.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { webFetch } from "./fetch/fetch.js";
import { buildWebSearchSchema, type WebFetchParams, WebFetchParamsSchema } from "./schema.js";
import { searchWithExa } from "./search/api/exa.js";
import { searchWithFirecrawl } from "./search/api/firecrawl.js";
import { searchWithTavily } from "./search/api/tavily.js";
import { searchWithTinyfish } from "./search/api/tinyfish.js";
import { pickEngine, searchWithBsk } from "./search/browser.js";
import { candidatesFor } from "./search/channels.js";
import type { ChannelId, FetchToolData, SearchResultItem, SearchToolData, WebSearchParams } from "./types.js";
import { fetchView, searchView } from "./views.js";

// ── Result formatting (LLM-facing, token friendly) ───────────────

function formatResults(result: SearchResultItem[]): string {
	if (result.length === 0) return "No results.";
	return result
		.map((r, i) => {
			const meta = [r.pageAge, r.author].filter(Boolean).join(" · ");
			const head = meta ? `${i + 1}. ${r.title} (${meta})` : `${i + 1}. ${r.title}`;
			return `${head}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`;
		})
		.join("\n");
}

/** build the final tool result. */
function finalizeResult(
	result: SearchResultItem[],
	channel: ChannelId,
	engine: SearchToolData["engine"],
	params: WebSearchParams,
	startedAt: number,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: boolean } {
	return {
		content: [{ type: "text", text: formatResults(result) }],
		details: {
			data: {
				results: result,
				channel,
				...(engine ? { engine } : {}),
				...(params.locale ? { locale: params.locale } : {}),
				count: result.length,
				startedAt,
				endedAt: Date.now(),
			} satisfies SearchToolData,
		},
		isError: false,
	};
}

// ── web_search ───────────────────────────────────────────────────

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: boolean;
};

async function executeSearch(
	params: WebSearchParams,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void)
		| undefined,
): Promise<ToolResult> {
	const startedAt = Date.now();
	if (!params.query?.trim()) {
		return {
			content: [{ type: "text", text: "`query` is required." }],
			details: { error: "`query` is required." },
			isError: true,
		};
	}

	// Walk the fuse order; a channel that cannot honor the request's filters
	// is not a candidate (SPEC: 能力缺失不静默，跳过而非降级).
	const candidates = await candidatesFor(params);
	if (candidates.length === 0) {
		return {
			content: [{ type: "text", text: "No search channel is available." }],
			details: { error: "No search channel is available.", query: params.query },
			isError: true,
		};
	}

	const failures: { channel: string; error: string; hint?: string }[] = [];
	for (const channel of candidates) {
		// Surface the channel being tried on the live card (updates if a
		// failure falls through to the next candidate).
		onUpdate?.({
			content: [{ type: "text", text: `Searching "${params.query}" via ${channel}\u2026` }],
			details: { query: params.query, channel },
		});
		try {
			const result = await runChannel(channel, params, signal);
			return finalizeResult(
				result,
				channel,
				channel === "bsk" ? pickEngine(params.locale) : undefined,
				params,
				startedAt,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Config guidance travels in details (UI), never in LLM text
			// (SPEC 错误分层: LLM 不含安装/配置指引).
			const maybeHint = (err as { hint?: unknown }).hint;
			const hint = typeof maybeHint === "string" ? maybeHint : undefined;
			failures.push({ channel, error: message, ...(hint ? { hint } : {}) });
		}
	}

	const message = `All search channels failed: ${failures.map((f) => `${f.channel} (${f.error})`).join("; ")}`;
	return {
		content: [{ type: "text", text: failures[failures.length - 1]?.error ?? message }],
		details: { error: message, failures, query: params.query, startedAt, endedAt: Date.now() },
		isError: true,
	};
}

async function runChannel(
	channel: ChannelId,
	params: WebSearchParams,
	signal: AbortSignal | undefined,
): Promise<SearchResultItem[]> {
	switch (channel) {
		case "tinyfish":
			return searchWithTinyfish(params, { signal });
		case "exa":
			return searchWithExa(params, { signal });
		case "tavily":
			return searchWithTavily(params, { signal });
		case "firecrawl":
			return searchWithFirecrawl(params, { signal });
		case "bsk":
			return searchWithBsk(params, { signal });
	}
}

// ── web_fetch ────────────────────────────────────────────────────

async function executeFetch(
	args: WebFetchParams,
	signal: AbortSignal | undefined,
): Promise<{
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	details: Record<string, unknown>;
	isError: boolean;
}> {
	const url = args.url;
	const startedAt = Date.now();
	const result = await webFetch(url, { raw: args.raw, signal });
	if (result.error) {
		return {
			content: [{ type: "text", text: result.error }],
			details: { error: result.error, url, startedAt, endedAt: Date.now() },
			isError: true,
		};
	}
	// LLM-visible markers (preview pointer / not-inlined) are shaped by the
	// fetch layer — here the title prefix is the only addition.
	const text = result.title ? `${result.title}\n\n${result.content}` : result.content;
	const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
		{ type: "text", text },
	];
	if (result.image) {
		content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
	}
	return {
		content,
		details: {
			data: {
				title: result.title,
				content: result.content,
				contentType: result.contentType,
				startedAt,
				endedAt: Date.now(),
			} satisfies FetchToolData,
		},
		isError: false,
	};
}

// ── Extension registration ───────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Re-attach isError for tool results (pi drops the execute() isError flag
	// for normal returns — same pattern as pi-subagent).
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "web_search" && event.toolName !== "web_fetch") return undefined;
		const details = event.details as { error?: unknown } | undefined;
		if (!details || details.error === undefined) return undefined;
		return { isError: true };
	});

	pi.registerTool({
		name: "web_search",
		label: "Search the Web",
		description: "Search the web for current or external information.",
		promptSnippet: "Search the web",
		promptGuidelines: ["Write the query in the language whose results you want."],
		parameters: buildWebSearchSchema(),
		...searchView,
		async execute(_toolCallId, raw, signal, onUpdate) {
			return executeSearch(raw as WebSearchParams, signal, onUpdate);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Fetch a URL",
		description:
			"Fetch a URL and return its content, converted to readable Markdown when applicable. " + "Plain http(s) GET.",
		promptSnippet: "Fetch a URL (readable or raw source)",
		promptGuidelines: [
			"Use web_fetch to read the content of a specific URL.",
			"Prefer web_fetch over bash curl for plain HTML pages — it returns clean Markdown.",
		],
		parameters: WebFetchParamsSchema,
		...fetchView,
		async execute(_toolCallId, raw, signal) {
			const args = raw as WebFetchParams;
			return executeFetch(args, signal);
		},
	});
}
