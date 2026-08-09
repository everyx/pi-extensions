/**
 * pi-web-tools — Parallel channel (official SDK parallel-web).
 *
 * Requires PARALLEL_API_KEY. Supports domains (source_policy) + recency
 * (after_date). No operator syntax, no locale.
 */

import Parallel from "parallel-web";
import { createRateLimiter } from "../../rate-limit.ts";
import type { ChannelSearchContext, ChannelSearchResult, SearchResultItem, WebSearchParams } from "../../types.ts";
import { recencyToParallel } from "../recency.ts";

const DEFAULT_RESULTS = 5;

// Parallel search: 600 RPM = 10 qps (researched).
const limiter = createRateLimiter(10);

export function isParallelAvailable(): boolean {
	const key = process.env.PARALLEL_API_KEY?.trim();
	return !!key;
}

function requireKey(): string {
	const key = process.env.PARALLEL_API_KEY?.trim();
	if (!key) throw new Error("Parallel channel requires PARALLEL_API_KEY.");
	return key;
}

export async function searchWithParallel(
	params: WebSearchParams,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	const client = new Parallel({ apiKey: requireKey() });

	const response = await limiter.run(() =>
		client.search({
			objective: params.query,
			search_queries: [params.query],
			advanced_settings: {
				max_results: DEFAULT_RESULTS,
				...(params.allowed_domains?.length || params.blocked_domains?.length || params.recency
					? {
							source_policy: {
								...(params.allowed_domains?.length ? { include_domains: params.allowed_domains } : {}),
								...(params.blocked_domains?.length ? { exclude_domains: params.blocked_domains } : {}),
								...(params.recency ? { after_date: recencyToParallel(params.recency) } : {}),
							},
						}
					: {}),
			},
		}),
	);

	// SDK has no per-request signal; it uses its own fetch underneath.
	void ctx;

	const results: SearchResultItem[] = (response.results ?? [])
		.filter((r) => r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.excerpts ?? []).join("\n"),
			...(r.publish_date ? { publishedDate: r.publish_date } : {}),
		}));
	return { results, total: results.length };
}
