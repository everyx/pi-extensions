/**
 * pi-web-tools — Tavily channel (raw REST — the official SDK's types lag the
 * country/language params the API supports).
 *
 * Requires TAVILY_API_KEY (free tier: 1,000 credits/month). Full param
 * surface: query, max_results, time_range, include/exclude_domains,
 * country (market boost, general topic only), language (boost mode —
 * hard filtering stays off so bilingual results survive).
 */

import { isoToRelativeAge } from "../../date.js";
import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";
import type { ChannelSearchContext, SearchResultItem, WebSearchParams } from "../../types.js";
import { parseLocale } from "../bcp47.js";
import { recencyToTavily } from "../recency.js";

const ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_RESULTS = 5;

// Tavily free tier: 1 req/s, account-level (researched).
const limiter = createRateLimiter(1);

/** Tavily's country param takes lowercase English country names, not ISO
 *  codes — the markets we can name; unmapped codes just skip the boost. */
const COUNTRY_NAMES: Record<string, string> = {
	CN: "china",
	US: "united states",
	GB: "united kingdom",
	JP: "japan",
	KR: "south korea",
	DE: "germany",
	FR: "france",
	ES: "spain",
	PT: "portugal",
	RU: "russia",
	IN: "india",
	BR: "brazil",
	CA: "canada",
	AU: "australia",
	SG: "singapore",
	TW: "taiwan",
};

export function isTavilyAvailable(): boolean {
	const key = process.env.TAVILY_API_KEY?.trim();
	return !!key;
}

export async function searchWithTavily(
	params: WebSearchParams,
	ctx: ChannelSearchContext,
): Promise<SearchResultItem[]> {
	const key = process.env.TAVILY_API_KEY?.trim();
	if (!key) throw new Error("Tavily channel requires TAVILY_API_KEY.");

	const { language, country } = parseLocale(params.locale);
	const body: Record<string, unknown> = {
		query: params.query,
		max_results: DEFAULT_RESULTS,
		...(params.allowed_domains?.length ? { include_domains: params.allowed_domains } : {}),
		...(params.blocked_domains?.length ? { exclude_domains: params.blocked_domains } : {}),
		...(params.recency ? { time_range: recencyToTavily(params.recency) } : {}),
		...(country && COUNTRY_NAMES[country] ? { country: COUNTRY_NAMES[country] } : {}),
		...(language ? { language } : {}),
	};

	const response = await limiter.run(() =>
		fetchWithTimeout(
			ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
			},
			{ signal: ctx.signal },
		),
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Tavily error ${response.status}: ${text.slice(0, 300)}`);
	}

	const payload = (await response.json()) as {
		results?: Array<{
			title?: string;
			url?: string;
			content?: string;
			publishedDate?: string | null;
		}>;
	};
	return (payload.results ?? [])
		.filter((r): r is { title?: string; url: string; content?: string; publishedDate?: string | null } => !!r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.content || "").replace(/\s+/g, " ").trim(),
			...(r.publishedDate ? { pageAge: isoToRelativeAge(r.publishedDate) } : {}),
		}));
}
