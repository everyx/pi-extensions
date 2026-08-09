/**
 * pi-web-tools — date helpers.
 *
 * Channels report publication dates in different shapes (ISO, partial ISO
 * from Exa MCP "Published"). We normalize everything to a relative age
 * string ("2 years and 3 months ago") — the LLM-friendly form Anthropic/
 * DeepSeek serve natively via web_search_result.page_age. The conversion
 * uses the mature `fromnow` library (compound units, maintained).
 */

import fromNow from "fromnow";

/** Convert an ISO date (or "YYYY-MM-DD") to a compound relative age string. */
export function isoToRelativeAge(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	// max: 2 → up to two units ("2 years and 3 months ago").
	return fromNow(iso, { max: 2, suffix: true, and: true });
}
