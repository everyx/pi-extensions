/**
 * pi-web-tools — TinyFish Fetch channel (raw REST, keyless-first).
 *
 * POST https://api.fetch.tinyfish.ai — real-browser rendering for JS-heavy
 * pages, clean Markdown back (nav/ads/boilerplate stripped). Free tier (150
 * URLs/min); keyless first, TINYFISH_API_KEY (shared with the search
 * channel) as an optional upgrade.
 *
 * Sits in the web_fetch fuse (SPEC: GET → tinyfish fetch → bsk): pages plain
 * HTTP cannot deliver (anti-bot walls, CSR shells) render here instead of
 * locally — one renderer implementation instead of two.
 */

import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";

const ENDPOINT = "https://api.fetch.tinyfish.ai";

// Free tier is 150 URLs/min — 2 qps keeps bursts polite.
const limiter = createRateLimiter(2);

interface TinyfishFetchResponse {
	results?: Array<{ url?: string; title?: string; text?: string }>;
	/** Per-URL failures land here and do not fail the whole request. */
	errors?: Array<{ url?: string; error?: string }>;
}

/** Fetch one URL via TinyFish's browser rendering; null on any failure.
 *  Callers treat null like the channel being unavailable (fuse advance). */
export async function fetchWithTinyfish(url: string, signal?: AbortSignal): Promise<string | null> {
	const key = process.env.TINYFISH_API_KEY?.trim();
	try {
		return await limiter.run(async () => {
			const response = await fetchWithTimeout(
				ENDPOINT,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(key ? { "X-API-Key": key } : {}),
					},
					body: JSON.stringify({ urls: [url], format: "markdown" }),
				},
				{ signal, timeoutMs: 30_000 },
			);
			if (!response.ok) return null;
			const body = (await response.json()) as TinyfishFetchResponse;
			const result = body.results?.find((r) => r.url === url) ?? body.results?.[0];
			return result?.text?.trim() || null;
		});
	} catch {
		return null;
	}
}
