/**
 * pi-web-tools — channel capabilities and routing (SPEC: 能力与路由).
 *
 * Pure functions: the channel capability matrix (static), request capability
 * extraction, and route() — pick the channel that satisfies the requested
 * capabilities among the available ones, or report an explicit error.
 * Availability (which channels are usable right now) is detected by the
 * caller and passed in — keeps this layer synchronous and unit-testable.
 */

import type { ChannelCapabilities, ChannelId, EngineId, RequestedCapabilities, WebSearchParams } from "../types.js";
import { enginePriorityForLocale, primaryLanguage } from "./locale.js";

/** SPEC 通道能力矩阵 (code-ified).
 * tavily's locale is a bare `country` param — not the domain-level
 * localization the spec promises, so it stays out of the locale path
 * (auto + locale routes to bsk, the only real localization). */
export const CHANNEL_CAPABILITIES: Record<ChannelId, ChannelCapabilities> = {
	exa: { domains: true, recency: true, locale: false },
	tavily: { domains: true, recency: true, locale: false },
	parallel: { domains: true, recency: true, locale: false },
	bsk: { domains: true, recency: true, locale: true },
};

/**
 * Free-API-first fallback order for `engine: "auto"` (SPEC: fallback 链).
 * The default order; the enabled set (PI_WEB_TOOLS_ENGINES) filters it at
 * startup. api channels are key-gated at call time.
 */
export const DEFAULT_CHANNEL_ORDER: ChannelId[] = ["exa", "tavily", "parallel", "bsk"];

/** The api channel group (SPEC: agent 搜索引擎 — key-gated, inside auto). */
export const API_CHANNELS: ChannelId[] = ["exa", "tavily", "parallel"];

/** The traditional-engine ids (bsk channel). */
export const ENGINE_IDS: EngineId[] = ["google", "bing", "baidu", "yandex"];

// ── enabled set (PI_WEB_TOOLS_ENGINES) ──────────────────────────

/**
 * Parse PI_WEB_TOOLS_ENGINES ("exa,tavily,google,bing" → api + engines
 * subsets). Unknown names are dropped; order is preserved. undefined when
 * unset/empty → caller falls back to defaults.
 */
export function parseEnginesConfig(raw?: string): { api: ChannelId[]; engines: EngineId[] } | undefined {
	if (!raw) return undefined;
	const parts = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (parts.length === 0) return undefined;
	const api = [...new Set(parts.filter((s): s is ChannelId => (API_CHANNELS as string[]).includes(s)))];
	const engines = [...new Set(parts.filter((s): s is EngineId => (ENGINE_IDS as string[]).includes(s)))];
	// Nothing recognizable → treat as unset (fall back to defaults) rather
	// than disabling everything on a typo.
	if (api.length === 0 && engines.length === 0) return undefined;
	return { api, engines };
}

/**
 * Default engine set for a language (SPEC: 系统 locale 决定启用集).
 * google is the global fallback everywhere; each localized language adds
 * exactly one localization-specialist (zh → bing/cn.bing.com, ru →
 * yandex/yandex.ru). Everything else is google-only — bing/baidu only
 * come in via an explicit PI_WEB_TOOLS_ENGINES.
 */
export function defaultEnginesFor(language: string): EngineId[] {
	if (language === "zh") return ["bing", "google"];
	if (language === "ru") return ["yandex", "google"];
	return ["google"];
}

/** Resolve the bsk engine set: config wins, else the system-locale default. */
export function resolveEngines(config: { engines: EngineId[] } | undefined, systemLocale: string): EngineId[] {
	if (config) return config.engines;
	return defaultEnginesFor(primaryLanguage(systemLocale));
}

/** Resolve the api channel set: config wins (excludes unlisted), else all. */
export function resolveApiChannels(config: { api: ChannelId[] } | undefined): ChannelId[] {
	if (config) return config.api;
	return [...API_CHANNELS];
}

/**
 * Effective capabilities for a channel at runtime.
 *
 * Static matrix by default; a caller may supply overrides for channels whose
 * capabilities depend on the active mode (e.g. Exa keyless MCP only exposes
 * query + numResults — no domains/recency/locale).
 */
export function effectiveCapabilities(
	channel: ChannelId,
	overrides?: Partial<Record<ChannelId, ChannelCapabilities>>,
): ChannelCapabilities {
	return overrides?.[channel] ?? CHANNEL_CAPABILITIES[channel];
}

/** Extract the capabilities a web_search call actually requests. */
export function requestedCapabilities(params: WebSearchParams): RequestedCapabilities {
	return {
		domains: !!params.allowed_domains?.length || !!params.blocked_domains?.length,
		recency: !!params.recency,
		locale: !!params.locale,
	};
}

export interface RouteResult {
	channel: ChannelId;
	/** For bsk: which engine to use. */
	engine?: EngineId;
}

export interface RouteFailure {
	error: string;
	/** Capabilities no available channel satisfied — only capability failures carry this. */
	unsatisfied?: string[];
	/** Config guidance — details-only, never into LLM context (SPEC: 错误分层). */
	hint?: string;
}

/** Optional knobs for route()/orderedCandidates() — kept as one bundle so
 * the signatures stay stable as the enabled-set concept grows. */
export interface RouteOptions {
	/** Candidate order (defaults to DEFAULT_CHANNEL_ORDER). */
	order?: ChannelId[];
	/** Runtime capability overrides (e.g. keyless Exa MCP). */
	capabilities?: Partial<Record<ChannelId, ChannelCapabilities>>;
	/** Enabled bsk engine set (SPEC: 启用集). */
	engines?: EngineId[];
}

/**
 * Route a search request to a channel.
 *
 * - `engine` != auto → bsk with that engine (operator gate). Errors if bsk is
 *   not among `available`, or the engine is not in the enabled set.
 * - otherwise → first available channel (in `order`) whose capabilities
 *   cover the requested ones. Explicit error when none does (no silent
 *   capability drop).
 *
 * `options.engines` = the enabled bsk engine set; the bsk engine is the
 * locale-priority engine that is enabled (no locale → google).
 */
export function route(
	params: WebSearchParams,
	available: ChannelId[],
	options: RouteOptions = {},
): RouteResult | RouteFailure {
	const { order = DEFAULT_CHANNEL_ORDER, capabilities, engines } = options;
	const requested = requestedCapabilities(params);

	if (params.engine && params.engine !== "auto") {
		if (!available.includes("bsk")) {
			return {
				error: `engine "${params.engine}" requires the real-browser channel (bsk), which is not available.`,
			};
		}
		if (engines && !engines.includes(params.engine)) {
			return {
				error: `engine "${params.engine}" is not enabled.`,
				hint: `set PI_WEB_TOOLS_ENGINES to include "${params.engine}"`,
			};
		}
		return { channel: "bsk", engine: params.engine };
	}

	for (const channel of order) {
		if (!available.includes(channel)) continue;
		if (capabilitiesCover(channel, requested, capabilities)) {
			// bsk needs an engine even on the capability path — the locale's
			// top-priority engine that is enabled (SPEC: 引擎优先级按语言分组).
			if (channel === "bsk") {
				return { channel, engine: pickEngine(params.locale, engines) };
			}
			return { channel };
		}
	}

	const unsatisfied = Object.entries(requested)
		.filter(([, v]) => v)
		.map(([k]) => k);
	return {
		error: `No available channel supports the requested capabilities: ${unsatisfied.join(", ")}.`,
		unsatisfied,
	};
}

/** The bsk engine for a request: locale priority ∩ enabled set (no locale → google). */
function pickEngine(locale: string | undefined, engines?: EngineId[]): EngineId {
	const priority = enginePriorityForLocale(locale);
	if (engines && engines.length > 0) {
		const hit = priority.find((e) => engines.includes(e));
		if (hit) return hit;
		return engines[0];
	}
	return priority[0];
}

function capabilitiesCover(
	channel: ChannelId,
	requested: RequestedCapabilities,
	overrides?: Partial<Record<ChannelId, ChannelCapabilities>>,
): boolean {
	const caps = effectiveCapabilities(channel, overrides);
	return (
		(!requested.domains || caps.domains) && (!requested.recency || caps.recency) && (!requested.locale || caps.locale)
	);
}

/** True when the channel can handle every requested capability (no silent drop). */
export function satisfies(
	channel: ChannelId,
	requested: RequestedCapabilities,
	overrides?: Partial<Record<ChannelId, ChannelCapabilities>>,
): boolean {
	return capabilitiesCover(channel, requested, overrides);
}

/**
 * Ordered list of usable channels for a request: every available channel in
 * `order` whose capabilities cover the request. bsk entries carry the
 * enabled locale-priority engine (SPEC: 引擎优先级按语言分组).
 */
export function orderedCandidates(
	params: WebSearchParams,
	available: ChannelId[],
	options: RouteOptions = {},
): Array<{ channel: ChannelId; engine?: EngineId }> {
	const { order = DEFAULT_CHANNEL_ORDER, capabilities, engines } = options;
	const requested = requestedCapabilities(params);
	return order
		.filter((c) => available.includes(c) && satisfies(c, requested, capabilities))
		.map((c) => (c === "bsk" ? { channel: c, engine: pickEngine(params.locale, engines) } : { channel: c }));
}
