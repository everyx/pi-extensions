/**
 * pi-web-tools — Tavily channel (official SDK @tavily/core).
 *
 * Requires TAVILY_API_KEY. Supports domains + recency natively; locale via
 * the country param when a region is present.
 */

import { tavily } from "@tavily/core";
import type { ChannelSearchContext, ChannelSearchResult, SearchResultItem, WebSearchParams } from "../../types.ts";
import { countryFromLocale } from "../locale.ts";

const DEFAULT_RESULTS = 5;

export function isTavilyAvailable(): boolean {
	const key = process.env.TAVILY_API_KEY?.trim();
	return !!key;
}

function requireKey(): string {
	const key = process.env.TAVILY_API_KEY?.trim();
	if (!key) throw new Error("Tavily channel requires TAVILY_API_KEY.");
	return key;
}

export async function searchWithTavily(
	params: WebSearchParams,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	const client = tavily({ apiKey: requireKey() });
	const response = await client.search(params.query, {
		maxResults: DEFAULT_RESULTS,
		includeAnswer: "basic",
		...(params.allowed_domains?.length ? { includeDomains: params.allowed_domains } : {}),
		...(params.blocked_domains?.length ? { excludeDomains: params.blocked_domains } : {}),
		...(params.recency ? { timeRange: params.recency } : {}),
		...(countryFromLocale(params.locale) ? { country: countryFromLocale(params.locale) } : {}),
	});

	// SDK has no per-request signal; it uses its own fetch underneath.
	void ctx;

	const results: SearchResultItem[] = (response.results ?? [])
		.filter((r) => r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.content || "").replace(/\s+/g, " ").trim().slice(0, 300),
		}));
	return { results, total: results.length, answer: response.answer };
}
