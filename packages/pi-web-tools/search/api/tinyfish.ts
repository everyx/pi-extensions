/**
 * pi-web-tools — TinyFish channel (raw REST, X-API-Key).
 *
 * Requires TINYFISH_API_KEY (free, unlimited volume at 30 req/min — the
 * chain's primary channel). Full param surface: query, location/language,
 * recency_minutes, include/exclude_domains. GET with query-string params.
 */

import { isoToRelativeAge } from "../../date.js";
import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";
import type { ChannelSearchContext, SearchResultItem, WebSearchParams } from "../../types.js";
import { parseLocale } from "../bcp47.js";
import { recencyToMinutes } from "../recency.js";

const ENDPOINT = "https://api.search.tinyfish.ai";

// Free tier is 30 req/min per key — 2 qps keeps bursts polite.
const limiter = createRateLimiter(2);

export function tinyfishApiKey(): string | null {
	const key = process.env.TINYFISH_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}

export async function searchWithTinyfish(
	params: WebSearchParams,
	ctx: ChannelSearchContext,
): Promise<SearchResultItem[]> {
	const key = tinyfishApiKey();
	if (!key) throw new Error("Tinyfish channel requires TINYFISH_API_KEY.");

	const url = new URL(ENDPOINT);
	url.searchParams.set("query", params.query);
	// locale: language always maps; location rides along when derivable.
	// TinyFish auto-resolves the pairing when only one is given.
	const { language, country } = parseLocale(params.locale);
	if (language) url.searchParams.set("language", language);
	if (country) url.searchParams.set("location", country);
	if (params.recency) url.searchParams.set("recency_minutes", String(recencyToMinutes(params.recency)));
	if (params.allowed_domains?.length) url.searchParams.set("include_domains", params.allowed_domains.join(","));
	if (params.blocked_domains?.length) url.searchParams.set("exclude_domains", params.blocked_domains.join(","));

	const response = await limiter.run(() =>
		fetchWithTimeout(url.href, { headers: { "X-API-Key": key } }, { signal: ctx.signal, timeoutMs: ctx.timeoutMs }),
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Tinyfish error ${response.status}: ${text.slice(0, 300)}`);
	}

	const body = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; snippet?: string; date?: string }>;
	};
	return (body.results ?? [])
		.filter((r): r is { title?: string; url: string; snippet?: string; date?: string } => !!r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: r.snippet || "",
			...(r.date ? { pageAge: isoToRelativeAge(r.date) } : {}),
		}));
}
