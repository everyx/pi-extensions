/**
 * pi-web-tools — extension entry: registers web_search + web_fetch.
 *
 * Channels (SPEC 通道架构): free search APIs (Exa/Tavily/Parallel, key-gated)
 * → real browser (bsk). The enabled set — which api channels and which
 * traditional engines are usable — is resolved once at startup from
 * PI_WEB_TOOLS_ENGINES (or the system locale's default set) and mirrored
 * into the engine enum (SPEC: 枚举即事实). Engines only surface when bsk is
 * installed, so the LLM never sees a dead option. LLM sees only results or
 * a terse error; engine echo and diagnostics live in details (UI-visible).
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { webFetch } from "./fetch/fetch.js";
import { buildWebSearchSchema, type WebFetchParams, WebFetchParamsSchema } from "./schema.js";
import { exaApiKey, isExaAvailable, searchWithExa } from "./search/api/exa.js";
import { isParallelAvailable, searchWithParallel } from "./search/api/parallel.js";
import { isTavilyAvailable, searchWithTavily } from "./search/api/tavily.js";
import { searchWithBsk } from "./search/browser.js";
import {
	orderedCandidates,
	parseEnginesConfig,
	requestedCapabilities,
	resolveApiChannels,
	resolveEngines,
	route,
} from "./search/channels.js";
import { systemLocale } from "./search/system-locale.js";
import type { ChannelCapabilities, ChannelId, EngineId, SearchResultItem, WebSearchParams } from "./types.js";
import { fetchView, searchView } from "./views.js";

const execFileAsync = promisify(execFile);

// ── Enabled set (resolved once at startup — SPEC: 启动时静态定) ────

/** The enabled api channels + bsk engines. Config wins; else system-locale
 * defaults. Mirrored into the engine enum so the LLM only sees usable
 * engines (SPEC: 枚举即事实) — engines additionally require bsk to be
 * installed, otherwise they'd be dead options at call time. */
function isBskInstalledSync(): boolean {
	try {
		execFileSync("bsk", ["--version"], { timeout: 5_000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const systemLocaleValue = systemLocale();
const enginesConfig = parseEnginesConfig(process.env.PI_WEB_TOOLS_ENGINES);
const ENABLED = {
	api: resolveApiChannels(enginesConfig),
	engines: isBskInstalledSync() ? resolveEngines(enginesConfig, systemLocaleValue) : [],
};

// ── Channel availability ─────────────────────────────────────────

async function isBskAvailable(): Promise<boolean> {
	try {
		await execFileAsync("bsk", ["--version"], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

async function detectAvailableChannels(
	enabled: { api: ChannelId[]; engines: EngineId[] } = ENABLED,
): Promise<{ available: ChannelId[]; capabilities: Partial<Record<ChannelId, ChannelCapabilities>> }> {
	const channels: ChannelId[] = [];
	const capabilities: Partial<Record<ChannelId, ChannelCapabilities>> = {};
	// api channels: enabled set ∩ key availability (SPEC: api 组 key 驱动).
	if (enabled.api.includes("exa") && isExaAvailable()) {
		channels.push("exa");
		// Keyless Exa goes through MCP, which exposes only query + numResults
		// (researched) — no domains/recency/locale. With a key (REST) it's full.
		if (!exaApiKey()) {
			capabilities.exa = { domains: false, recency: false, locale: false, operators: false };
		}
	}
	if (enabled.api.includes("tavily") && isTavilyAvailable()) channels.push("tavily");
	if (enabled.api.includes("parallel") && isParallelAvailable()) channels.push("parallel");
	// bsk: only when at least one engine is enabled (SPEC: 启用集非空才有 bsk).
	if (enabled.engines.length > 0 && (await isBskAvailable())) channels.push("bsk");
	return { available: channels, capabilities };
}

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
	candidate: { channel: ChannelId; engine?: EngineId },
	locale: string | undefined,
	startedAt: number,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: boolean } {
	return {
		content: [{ type: "text", text: formatResults(result) }],
		details: {
			data: {
				results: result,
				channel: candidate.channel,
				...(candidate.engine ? { engine: candidate.engine } : {}),
				...(locale ? { locale } : {}),
				count: result.length,
				startedAt,
				endedAt: Date.now(),
			},
		},
		isError: false,
	};
}

// ── web_search ───────────────────────────────────────────────────

async function executeSearch(
	params: WebSearchParams,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void)
		| undefined,
): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: boolean;
}> {
	const startedAt = Date.now();
	if (!params.query?.trim()) {
		return {
			content: [{ type: "text", text: "`query` is required." }],
			details: { error: "`query` is required." },
			isError: true,
		};
	}

	const { available, capabilities } = await detectAvailableChannels();
	const routeOptions = { capabilities, engines: ENABLED.engines };

	// Explicit engine: honor the intent — no auto-fallback on failure.
	if (params.engine && params.engine !== "auto") {
		const routed = route(params, available, routeOptions);
		if ("error" in routed) {
			return {
				content: [{ type: "text", text: routed.error }],
				details: { error: routed.error, hint: routed.hint, unsatisfied: routed.unsatisfied, available },
				isError: true,
			};
		}
		// The channel is known once routed — surface it on the live card
		// immediately (via …), even though the result count lands later.
		onUpdate?.({
			content: [{ type: "text", text: `Searching "${params.query}" via ${routed.channel}\u2026` }],
			details: { query: params.query, channel: routed.channel, engine: routed.engine },
		});
		try {
			const result = await runChannel(routed.channel, params, routed.engine, signal);
			return finalizeResult(result, { channel: routed.channel, engine: routed.engine }, params.locale, startedAt);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: message }],
				details: {
					error: message,
					channel: routed.channel,
					engine: routed.engine,
					query: params.query,
					startedAt,
					endedAt: Date.now(),
				},
				isError: true,
			};
		}
	}

	// engine auto: try candidates in order; on failure fall through to the
	// next usable channel (SPEC: 静默降级). All failures → terse error.
	const candidates = orderedCandidates(params, available, routeOptions);
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
		// Surface the channel being tried on the live card (updates if a
		// failure falls through to the next candidate).
		onUpdate?.({
			content: [{ type: "text", text: `Searching "${params.query}" via ${candidate.channel}\u2026` }],
			details: { query: params.query, channel: candidate.channel, engine: candidate.engine },
		});
		try {
			const result = await runChannel(candidate.channel, params, candidate.engine, signal);
			return finalizeResult(result, candidate, params.locale, startedAt);
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
		details: { error: message, failures, available, query: params.query, startedAt, endedAt: Date.now() },
		isError: true,
	};
}

async function runChannel(
	channel: ChannelId,
	params: WebSearchParams,
	engine: "google" | "bing" | "baidu" | "yandex" | undefined,
	signal: AbortSignal | undefined,
): Promise<SearchResultItem[]> {
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
			},
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
		description:
			"Search the web and return a list of results (title, url, snippet). " +
			"Each result carries the source text. engine: auto picks the best engine; " +
			"google/bing/baidu/yandex search with that engine and enable its native operator " +
			'syntax (site:, filetype:, intitle:, -exclude, "exact", OR). ' +
			"allowed_domains/blocked_domains work for every engine.",
		promptSnippet: "Search the web",
		promptGuidelines: [
			"Use web_search for anything that requires current or external information.",
			"Re-query with a different query when results are insufficient or you need different coverage.",
			"Use engine with operator syntax when you need site:, filetype:, intitle: filters; otherwise let auto pick the cheapest channel.",
			"Pass locale (BCP-47) when you want results localized to a language/region — e.g. zh-CN for Chinese results, ru-RU for Russian. Omit for global results.",
		],
		parameters: buildWebSearchSchema(ENABLED.engines),
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
