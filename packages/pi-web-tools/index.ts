/**
 * pi-web-tools — extension entry: registers web_search + web_fetch.
 *
 * Channels (SPEC 通道架构): free search APIs (Exa/Tavily/Parallel) →
 * real browser (bsk) → model grounding. User-config order override via
 * PI_WEB_TOOLS_CHANNELS. LLM sees only results or a terse error; engine
 * echo and diagnostics live in details (UI-visible).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { webFetch } from "./fetch/fetch.js";
import { WebFetchParamsSchema, WebSearchParamsSchema } from "./schema.js";
import { exaApiKey, isExaAvailable, searchWithExa } from "./search/api/exa.js";
import { isParallelAvailable, searchWithParallel } from "./search/api/parallel.js";
import { isTavilyAvailable, searchWithTavily } from "./search/api/tavily.js";
import { searchWithBsk } from "./search/browser.js";
import {
	DEFAULT_CHANNEL_ORDER,
	orderedCandidates,
	parseChannelOrder,
	requestedCapabilities,
	route,
} from "./search/channels.js";
import { type GroundingEndpoint, groundingEndpointFor, searchWithGrounding } from "./search/grounding.js";
import type { ChannelCapabilities, ChannelId, ChannelSearchResult, WebSearchParams } from "./types.js";

const execFileAsync = promisify(execFile);

// ── Channel availability ─────────────────────────────────────────

async function isBskAvailable(): Promise<boolean> {
	try {
		await execFileAsync("bsk", ["--version"], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

async function isGroundingAvailable(
	ctx: ExtensionContext,
): Promise<{ available: boolean; endpoint?: GroundingEndpoint; apiKey?: string }> {
	const model = ctx.model;
	if (!model) return { available: false };
	const endpoint = groundingEndpointFor(model.provider, model.baseUrl, model.id);
	if (!endpoint) return { available: false };
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) return { available: false };
	return { available: true, endpoint, apiKey };
}

async function detectAvailableChannels(
	ctx: ExtensionContext,
): Promise<{ available: ChannelId[]; capabilities: Partial<Record<ChannelId, ChannelCapabilities>> }> {
	const channels: ChannelId[] = [];
	const capabilities: Partial<Record<ChannelId, ChannelCapabilities>> = {};
	if (isExaAvailable()) {
		channels.push("exa");
		// Keyless Exa goes through MCP, which exposes only query + numResults
		// (researched) — no domains/recency/locale. With a key (REST) it's full.
		if (!exaApiKey()) {
			capabilities.exa = { domains: false, recency: false, locale: false, operators: false };
		}
	}
	if (isTavilyAvailable()) channels.push("tavily");
	if (isParallelAvailable()) channels.push("parallel");
	if (await isBskAvailable()) channels.push("bsk");
	const grounding = await isGroundingAvailable(ctx);
	if (grounding.available) channels.push("grounding");
	return { available: channels, capabilities };
}

// ── Result formatting (LLM-facing, token friendly) ───────────────

function formatResults(result: ChannelSearchResult): string {
	if (result.results.length === 0) return "No results.";
	const lines = result.results.map((r, i) => {
		const meta = [r.publishedDate, r.author].filter(Boolean).join(" · ");
		const head = meta ? `${i + 1}. ${r.title} (${meta})` : `${i + 1}. ${r.title}`;
		return `${head}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`;
	});
	const truncated =
		result.total > result.results.length ? `\n(${result.total} results total; showing ${result.results.length})` : "";
	return lines.join("\n") + truncated;
}

// ── web_search ───────────────────────────────────────────────────

async function executeSearch(
	params: WebSearchParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: boolean;
}> {
	if (!params.query?.trim()) {
		return {
			content: [{ type: "text", text: "`query` is required." }],
			details: { error: "`query` is required." },
			isError: true,
		};
	}

	const { available, capabilities } = await detectAvailableChannels(ctx);
	const order = parseChannelOrder(process.env.PI_WEB_TOOLS_CHANNELS) ?? DEFAULT_CHANNEL_ORDER;

	// Explicit engine: honor the intent — no auto-fallback on failure.
	if (params.engine && params.engine !== "auto") {
		const routed = route(params, available, order, capabilities);
		if ("error" in routed) {
			return {
				content: [{ type: "text", text: routed.error }],
				details: { error: routed.error, unsatisfied: routed.unsatisfied, available },
				isError: true,
			};
		}
		try {
			const result = await runChannel(routed.channel, params, routed.engine, ctx, signal);
			return {
				content: [{ type: "text", text: formatResults(result) }],
				details: {
					channel: routed.channel,
					...(routed.engine ? { engine: routed.engine } : {}),
					total: result.total,
					count: result.results.length,
				},
				isError: false,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: message }],
				details: { error: message, channel: routed.channel, engine: routed.engine, query: params.query },
				isError: true,
			};
		}
	}

	// engine auto: try candidates in order; on failure fall through to the
	// next usable channel (SPEC: 静默降级). All failures → terse error.
	const candidates = orderedCandidates(params, available, order, capabilities);
	if (candidates.length === 0) {
		const requested = requestedCapabilities(params);
		const unsatisfied = Object.entries(requested)
			.filter(([, v]) => v)
			.map(([k]) => k);
		const error = `No available channel supports the requested capabilities: ${unsatisfied.join(", ")}.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, unsatisfied, available },
			isError: true,
		};
	}

	const failures: { channel: string; error: string }[] = [];
	for (const candidate of candidates) {
		try {
			const result = await runChannel(candidate.channel, params, candidate.engine, ctx, signal);
			return {
				content: [{ type: "text", text: formatResults(result) }],
				details: {
					channel: candidate.channel,
					...(candidate.engine ? { engine: candidate.engine } : {}),
					total: result.total,
					count: result.results.length,
				},
				isError: false,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failures.push({ channel: candidate.channel, error: message });
		}
	}

	const last = failures[failures.length - 1];
	const message = last
		? `All search channels failed: ${failures.map((f) => `${f.channel} (${f.error})`).join("; ")}`
		: "Search failed.";
	return {
		content: [{ type: "text", text: last ? last.error : message }],
		details: { error: message, failures, available, query: params.query },
		isError: true,
	};
}

async function runChannel(
	channel: ChannelId,
	params: WebSearchParams,
	engine: "google" | "bing" | "baidu" | "yandex" | undefined,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<ChannelSearchResult> {
	switch (channel) {
		case "exa":
			return searchWithExa(params, { signal });
		case "tavily":
			return searchWithTavily(params, { signal });
		case "parallel":
			return searchWithParallel(params, { signal });
		case "bsk":
			if (!engine) throw new Error("internal error: bsk channel requires an engine");
			return searchWithBsk(params, engine, { signal });
		case "grounding": {
			const grounding = await isGroundingAvailable(ctx);
			if (!grounding.available || !grounding.endpoint || !grounding.apiKey) {
				throw new Error("grounding channel became unavailable.");
			}
			return searchWithGrounding(params, grounding.endpoint, grounding.apiKey, { signal });
		}
	}
}

// ── web_fetch ────────────────────────────────────────────────────

async function executeFetch(
	url: string,
	signal: AbortSignal | undefined,
): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: boolean;
}> {
	const result = await webFetch(url, signal);
	if (result.error) {
		return {
			content: [{ type: "text", text: result.error }],
			details: { error: result.error, url },
			isError: true,
		};
	}
	const text = result.title ? `${result.title}\n\n${result.markdown}` : result.markdown;
	return {
		content: [{ type: "text", text }],
		details: { url, title: result.title, markdownLength: result.markdown.length },
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
		description:
			"Search the web and return a list of results (title, url, snippet). " +
			"Use for anything outside your local machine: current facts, docs, code, people, prices. " +
			"Results may be truncated; the total is reported so you can re-query when you need more. " +
			"Set engine to google/bing/baidu/yandex to search with that real browser engine and use " +
			'its native operator syntax (site:, filetype:, intitle:, -exclude, "exact", OR). ' +
			"allowed_domains/blocked_domains work on every channel.",
		promptSnippet: "Search the web",
		promptGuidelines: [
			"Use web_search for anything that requires current or external information.",
			"Re-query with a different query when results are insufficient — total reports truncation.",
			"Use engine with operator syntax when you need site:, filetype:, intitle: filters; otherwise let auto pick the cheapest channel.",
		],
		parameters: WebSearchParamsSchema,
		async execute(_toolCallId, raw, signal, _onUpdate, ctx) {
			return executeSearch(raw as WebSearchParams, ctx, signal);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Fetch a URL",
		description:
			"Fetch a URL and return its content as Markdown (title + readable text). " +
			"Use to read the actual content behind a link, doc, or search result. " +
			"For authenticated pages, POST/API calls, or binary downloads, use bash curl instead.",
		promptSnippet: "Fetch a URL as Markdown",
		promptGuidelines: [
			"Use web_fetch to read the content of a specific URL (docs, articles, pages).",
			"Prefer web_fetch over bash curl for plain HTML pages — it returns clean Markdown.",
			"Use bash curl when you need auth cookies, POST bodies, or binary output.",
		],
		parameters: WebFetchParamsSchema,
		async execute(_toolCallId, raw, signal) {
			const url = (raw as { url: string }).url;
			return executeFetch(url, signal);
		},
	});
}
