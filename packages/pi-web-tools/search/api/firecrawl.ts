/**
 * pi-web-tools — Firecrawl channel (raw REST /v2/search, Google-backed).
 *
 * Two-stage quota strategy (SPEC: 免费层优先):
 *   1. keyless — free, per-IP daily caps (requests + credits), no header.
 *   2. keyed   — only after a keyless 429 and only when FIRECRAWL_API_KEY is
 *      set. The keyed pool is shared with pi-read-doc's OCR usage, so search
 *      touches it as rarely as possible.
 *
 * Domains: includeDomains/excludeDomains are mutually exclusive upstream, but
 * both are natively site: operators — when the caller passes both, allowed
 * goes through the param and blocked is appended to the query as -site:
 * (identical upstream semantics, both intents honored).
 */

import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";
import type { ChannelSearchContext, SearchResultItem, WebSearchParams } from "../../types.js";
import { parseLocale } from "../bcp47.js";
import { recencyToTbs } from "../recency.js";

const ENDPOINT = "https://api.firecrawl.dev/v2/search";
const LIMIT = 8;

// Keyless per-IP daily caps are unpublished — 1 qps keeps a burst from
// burning the day's allowance in seconds.
const limiter = createRateLimiter(1);

function firecrawlApiKey(): string | null {
	const key = process.env.FIRECRAWL_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}

/** Quota (429) failure — carries a user-facing hint separately from the
 *  LLM-safe message (SPEC 错误分层: 配置指引不进 LLM 文本). */
class FirecrawlQuotaError extends Error {
	constructor(
		message: string,
		readonly hint?: string,
	) {
		super(message);
	}
}

export async function searchWithFirecrawl(
	params: WebSearchParams,
	ctx: ChannelSearchContext,
): Promise<SearchResultItem[]> {
	return limiter.run(() =>
		searchOnce(params, ctx, false).catch((err) => {
			// Keyless quota exhausted (per-IP daily cap) → escalate to the shared
			// keyed pool when a key exists. Any other error propagates.
			if (!(err instanceof FirecrawlQuotaError)) throw err;
			const key = firecrawlApiKey();
			if (!key) {
				throw new FirecrawlQuotaError(
					"Firecrawl daily quota exhausted.",
					"Set FIRECRAWL_API_KEY for higher limits (free).",
				);
			}
			return searchOnce(params, ctx, true, key);
		}),
	);
}

async function searchOnce(
	params: WebSearchParams,
	ctx: ChannelSearchContext,
	keyed: boolean,
	key?: string,
): Promise<SearchResultItem[]> {
	// allowed via param; blocked via -site: operators in the query text (both
	// compile to the same upstream site:/-site: operators).
	const query =
		params.allowed_domains?.length && params.blocked_domains?.length
			? `${params.query} ${params.blocked_domains.map((d) => `-site:${d}`).join(" ")}`
			: params.query;

	const body: Record<string, unknown> = { query, limit: LIMIT };
	if (params.allowed_domains?.length) body.includeDomains = params.allowed_domains;
	else if (params.blocked_domains?.length) body.excludeDomains = params.blocked_domains;
	if (params.recency) body.tbs = recencyToTbs(params.recency);
	const { country } = parseLocale(params.locale);
	if (country) body.country = country;

	const response = await fetchWithTimeout(
		ENDPOINT,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(keyed && key ? { Authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify(body),
		},
		{ signal: ctx.signal },
	);

	if (response.status === 429) {
		throw keyed
			? new FirecrawlQuotaError(
					"Firecrawl quota exhausted (keyed).",
					"Firecrawl daily/credit limits reached — wait for reset or top up.",
				)
			: new FirecrawlQuotaError("Firecrawl keyless quota exhausted (429).");
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Firecrawl error ${response.status}: ${text.slice(0, 300)}`);
	}

	const payload = (await response.json()) as {
		data?: {
			web?: Array<{
				title?: string;
				url?: string;
				description?: string;
				highlights?: string[];
			}>;
		};
	};
	return (payload.data?.web ?? [])
		.filter((r): r is { title?: string; url: string; description?: string; highlights?: string[] } => !!r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.highlights?.length ? r.highlights.join(" … ") : r.description) || "",
		}));
}
