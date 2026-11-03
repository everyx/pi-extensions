/**
 * pi-web-tools — TinyFish Fetch channel (raw REST, keyed).
 *
 * POST https://api.fetch.tinyfish.ai — server-side rendering, clean Markdown
 * back. Second in the web_fetch fuse, and skipped outright without a key:
 * since 2026-11 the API answers 401 MISSING_API_KEY to anonymous calls, so
 * trying anyway would spend a round trip to learn nothing.
 */

import { apiKey } from "../../config.js";
import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";
import type { RenderOutcome } from "../../types.js";

const ENDPOINT = "https://api.fetch.tinyfish.ai";

// Free tier is 150 URLs/min — 2 qps keeps bursts polite.
const limiter = createRateLimiter(2);

interface TinyfishFetchResponse {
	results?: Array<{ url?: string; title?: string; text?: string }>;
	/** Per-URL failures land here and do not fail the whole request. */
	errors?: Array<{ url?: string; error?: string }>;
}

/** Whether this renderer can run at all. TinyFish began requiring a key
 *  (verified 2026-11-03: 401 MISSING_API_KEY without one), so it is skipped
 *  rather than spending a round trip on a refusal. */
export function tinyfishFetchKey(): string | null {
	const key = apiKey("tinyfish");
	return key && key.length > 0 ? key : null;
}

/** Fetch one URL via TinyFish's browser rendering (format: markdown — the
 *  API honors the request); null on any failure. Callers treat null like
 *  the channel being unavailable (fuse advance). */
export async function fetchWithTinyfish(
	url: string,
	/** Absolute epoch ms; the limiter uses it to let a queued call give up. */
	deadline: number,
	signal?: AbortSignal,
): Promise<RenderOutcome> {
	const key = tinyfishFetchKey();
	const outcome = await limiter
		.runBefore(
			async (): Promise<RenderOutcome> => {
				const remaining = deadline - Date.now();
				if (signal?.aborted || remaining <= 0) {
					return { content: null, reason: "fuse budget spent" };
				}
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
					{ signal, timeoutMs: Math.min(30_000, remaining) },
				);
				if (!response.ok) return { content: null, reason: `HTTP ${response.status}` };

				const body = (await response.json()) as TinyfishFetchResponse;
				const result = body.results?.find((r) => r.url === url) ?? body.results?.[0];
				const text = result?.text?.trim();
				const perUrl = body.errors?.[0]?.error;
				return text
					? { content: { text, contentType: "text/markdown" } }
					: { content: null, reason: perUrl ?? "empty text" };
			},
			{ deadline, signal },
		)
		.catch((err: unknown) => ({
			content: null,
			reason: err instanceof Error ? err.message : "request failed",
		}));

	// null means the call gave up while queued (deadline or cancellation).
	return outcome ?? { content: null, reason: "queue wait exceeded the fuse budget" };
}
