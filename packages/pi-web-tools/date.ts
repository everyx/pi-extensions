/**
 * pi-web-tools — date helpers.
 *
 * Channels report publication dates in different shapes (ISO, partial ISO
 * from Exa MCP "Published"). We normalize everything to a relative age
 * string ("about 3 hours ago") — the LLM-friendly form Anthropic/DeepSeek
 * serve natively via web_search_result.page_age.
 */

/** Convert an ISO date (or "YYYY-MM-DD") to a relative age string. */
export function isoToRelativeAge(iso: string, now: Date = new Date()): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	const diffMs = now.getTime() - ms;
	if (diffMs < 0) return "in the future";
	return msToRelativeAge(diffMs);
}

/** Convert a millisecond delta to "about N …" phrasing. */
export function msToRelativeAge(diffMs: number): string {
	const min = Math.floor(diffMs / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return pluralize("minute", min);
	const hours = Math.floor(min / 60);
	if (hours < 24) return pluralize("hour", hours);
	const days = Math.floor(hours / 24);
	if (days < 7) return pluralize("day", days);
	const weeks = Math.floor(days / 7);
	if (weeks < 5) return pluralize("week", weeks);
	const months = Math.floor(days / 30);
	if (months < 12) return pluralize("month", months);
	const years = Math.floor(days / 365);
	return pluralize("year", years);
}

function pluralize(unit: string, n: number): string {
	return `about ${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
