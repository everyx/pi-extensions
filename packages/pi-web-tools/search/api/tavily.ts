/**
 * pi-web-tools — Tavily channel (official SDK @tavily/core).
 *
 * Requires TAVILY_API_KEY. Supports domains + recency natively; no
 * localization (a bare `country` param is not the domain-level locale the
 * spec promises — auto + locale routes to bsk, see channels.ts).
 */

import { tavily } from "@tavily/core";
import { isoToRelativeAge } from "../../date.ts";
import { createRateLimiter } from "../../rate-limit.ts";
import type { ChannelSearchContext, SearchResultItem, WebSearchParams } from "../../types.ts";

const DEFAULT_RESULTS = 5;

// Tavily free tier: 1 req/s, account-level (researched).
const limiter = createRateLimiter(1);

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
): Promise<SearchResultItem[]> {
	const client = tavily({ apiKey: requireKey() });
	const response = await limiter.run(() =>
		client.search(params.query, {
			maxResults: DEFAULT_RESULTS,
			includeAnswer: "basic",
			...(params.allowed_domains?.length ? { includeDomains: params.allowed_domains } : {}),
			...(params.blocked_domains?.length ? { excludeDomains: params.blocked_domains } : {}),
			...(params.recency ? { timeRange: params.recency } : {}),
		}),
	);

	// SDK has no per-request signal; it uses its own fetch underneath.
	void ctx;

	const results: SearchResultItem[] = (response.results ?? [])
		.filter((r) => r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.content || "").replace(/\s+/g, " ").trim(),
			...(r.publishedDate ? { pageAge: isoToRelativeAge(r.publishedDate) } : {}),
		}));
	return results;
}
