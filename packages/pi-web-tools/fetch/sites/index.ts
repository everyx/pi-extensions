/**
 * pi-web-tools — site adapter registry (SPEC: web_fetch 行为规格).
 *
 * Each site adapter rewrites a URL so web_fetch returns the content the LLM
 * wants instead of a site's UI chrome. Adapters are mutually exclusive by
 * host; the registry iterates them in order.
 */

import { githubRawUrl } from "./github.js";

/** Site adapter: given a URL, return a rewritten one, or null if not applicable. */
type SiteAdapter = (url: string) => string | null;

const adapters: SiteAdapter[] = [githubRawUrl];

/** First applicable adapter's rewrite, or null when no adapter applies. */
export function adaptUrl(url: string): string | null {
	for (const adapt of adapters) {
		const rewritten = adapt(url);
		if (rewritten) return rewritten;
	}
	return null;
}
