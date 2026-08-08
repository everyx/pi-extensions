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

/** SPEC 通道能力矩阵 (code-ified). "operators" = native query-operator syntax. */
export const CHANNEL_CAPABILITIES: Record<ChannelId, ChannelCapabilities> = {
	exa: { domains: true, recency: true, locale: false, operators: false },
	tavily: { domains: true, recency: true, locale: true, operators: true }, // site:/布尔/引号
	parallel: { domains: true, recency: true, locale: false, operators: false },
	bsk: { domains: true, recency: true, locale: true, operators: true }, // 真实引擎全操作符
	grounding: { domains: false, recency: false, locale: false, operators: false },
};

/**
 * Free-API-first fallback order for `engine: "auto"` (SPEC: fallback 链).
 * The default order; overridable via PI_WEB_TOOLS_CHANNELS.
 */
export const DEFAULT_CHANNEL_ORDER: ChannelId[] = ["exa", "tavily", "parallel", "bsk", "grounding"];

/** Parse the PI_WEB_TOOLS_CHANNELS override ("api,bsk,grounding" → channel ids). */
export function parseChannelOrder(raw?: string): ChannelId[] | undefined {
	if (!raw) return undefined;
	const order = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is ChannelId => (DEFAULT_CHANNEL_ORDER as string[]).includes(s));
	if (order.length === 0) return undefined;
	// Keep the subset that names real channels, preserving the given order.
	return [...new Set(order)];
}

export function channelCapabilities(channel: ChannelId): ChannelCapabilities {
	return CHANNEL_CAPABILITIES[channel];
}

/** Extract the capabilities a web_search call actually requests. */
export function requestedCapabilities(params: WebSearchParams): RequestedCapabilities {
	return {
		domains: !!params.allowed_domains?.length || !!params.blocked_domains?.length,
		recency: !!params.recency,
		locale: !!params.locale,
		// engine != auto is the operator gate (SPEC: 操作符设计 — engine 门控).
		operators: !!params.engine && params.engine !== "auto",
	};
}

export interface RouteResult {
	channel: ChannelId;
	/** For bsk: which engine to use. */
	engine?: EngineId;
}

export interface RouteFailure {
	error: string;
	/** Capabilities no available channel satisfied (for the error message). */
	unsatisfied: string[];
}

/**
 * Route a search request to a channel.
 *
 * - `engine` != auto → bsk with that engine (operator gate). Errors if bsk is
 *   not among `available`.
 * - otherwise → first available channel (in `order`) whose capabilities
 *   cover the requested ones. Explicit error when none does (no silent
 *   capability drop).
 */
export function route(
	params: WebSearchParams,
	available: ChannelId[],
	order: ChannelId[] = DEFAULT_CHANNEL_ORDER,
): RouteResult | RouteFailure {
	const requested = requestedCapabilities(params);

	if (params.engine && params.engine !== "auto") {
		if (!available.includes("bsk")) {
			return {
				error: `engine "${params.engine}" requires the real-browser channel (bsk), which is not available.`,
				unsatisfied: ["operators"],
			};
		}
		return { channel: "bsk", engine: params.engine };
	}

	for (const channel of order) {
		if (!available.includes(channel)) continue;
		if (capabilitiesCover(channel, requested)) {
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

function capabilitiesCover(channel: ChannelId, requested: RequestedCapabilities): boolean {
	const caps = CHANNEL_CAPABILITIES[channel];
	return (
		(!requested.domains || caps.domains) &&
		(!requested.recency || caps.recency) &&
		(!requested.locale || caps.locale) &&
		(!requested.operators || caps.operators)
	);
}

/** True when the channel can handle every requested capability (no silent drop). */
export function satisfies(channel: ChannelId, requested: RequestedCapabilities): boolean {
	return capabilitiesCover(channel, requested);
}
