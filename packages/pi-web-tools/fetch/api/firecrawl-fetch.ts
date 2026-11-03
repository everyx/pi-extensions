/**
 * pi-web-tools — Firecrawl fetch channel (raw REST /v2/scrape, keyless-first).
 *
 * POST https://api.firecrawl.dev/v2/scrape — server-side rendering, Markdown
 * back. It is the first renderer in the web_fetch fuse for one reason: it is
 * the only one that answered without a key when the old browser tier was
 * removed (verified 2026-11-03: HTTP 200, 0.6 s). Tinyfish fetch used to hold
 * that slot and now answers 401 MISSING_API_KEY, so a keyless install would
 * otherwise have no renderer at all.
 *
 * Keyless per-IP daily caps are unpublished — 1 qps keeps a burst from
 * burning the day's allowance, and a 429 escalates to the keyed pool when a
 * key exists (same policy as the search channel, which shares the vendor).
 */

import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";
import type { RenderOutcome } from "../../types.js";

const ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

const limiter = createRateLimiter(1);

interface ScrapeResponse {
	success?: boolean;
	data?: { markdown?: string; metadata?: { title?: string } };
	error?: string;
}

/** Render one URL. A failed attempt carries its reason so the card can show
 *  which provider died and how, instead of a silent "no content". */
export async function fetchWithFirecrawl(
	url: string,
	/** Absolute epoch ms: the whole fuse shares one deadline. The limiter uses it
	 *  to let a *queued* call give up, not just to skip one that already waited. */
	deadline: number,
	signal?: AbortSignal,
): Promise<RenderOutcome> {
	const key = firecrawlFetchKey();
	const outcome = await limiter
		.runBefore(
			async (): Promise<RenderOutcome> => {
				// Each attempt gets what is left *now* — the 429 escalation is a second
				// round trip, and a budget computed once would let it run past the fuse
				// deadline the whole chain shares.
				const once = (apiKey: string | null) => {
					const remaining = deadline - Date.now();
					if (signal?.aborted || remaining <= 0) return Promise.resolve(null);
					return fetchWithTimeout(
						ENDPOINT,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
							},
							// Only markdown: the fuse feeds the same stash/preview path as
							// locally extracted text, so HTML would just be re-extracted.
							body: JSON.stringify({ url, formats: ["markdown"] }),
						},
						{ signal, timeoutMs: Math.min(30_000, remaining) },
					);
				};

				// Keyless first, like the search channel: the keyed pool is shared with
				// pi-read-doc's OCR credits and is only spent once the free tier says no.
				let response = await once(null);
				if (!response) return { content: null, reason: "fuse budget spent" };
				if (response.status === 429 && key) {
					const escalated = await once(key);
					if (!escalated) return { content: null, reason: "fuse budget spent after 429" };
					response = escalated;
				}
				if (!response.ok) return { content: null, reason: `HTTP ${response.status}` };

				const body = (await response.json()) as ScrapeResponse;
				const text = body.data?.markdown?.trim();
				return text ? { content: { text, contentType: "text/markdown" } } : { content: null, reason: "empty markdown" };
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

/** Whether a key is configured — mirrors the search channel's policy: the
 *  channel runs keyless regardless, the key only raises the ceiling. */
export function firecrawlFetchKey(): string | null {
	const key = process.env.FIRECRAWL_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}
