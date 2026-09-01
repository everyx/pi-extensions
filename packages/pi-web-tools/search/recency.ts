/**
 * pi-web-tools — recency mapping (SPEC: 跨通道映射).
 *
 * Each channel translates `recency: "day" | "week" | "month" | "year"`
 * into its native expression. Pure, unit-testable.
 */

type RecencyFilter = "day" | "week" | "month" | "year";

const DAYS: Record<RecencyFilter, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

/** Minutes N — TinyFish `recency_minutes` (1..5256000). */
export function recencyToMinutes(filter: RecencyFilter): number {
	return DAYS[filter] * 24 * 60;
}

/** ISO date (YYYY-MM-DD) N days ago — for APIs that take startPublishedDate. */
export function recencyToStartDate(filter: RecencyFilter, now: Date = new Date()): string {
	const d = new Date(now.getTime() - DAYS[filter] * 86_400_000);
	return d.toISOString().slice(0, 10);
}

/** Tavily `time_range` values. */
export function recencyToTavily(filter: RecencyFilter): string {
	return filter; // Tavily accepts day | week | month | year verbatim
}

/** Exa `startPublishedDate` (ISO date). */
export function recencyToExa(filter: RecencyFilter, now?: Date): string {
	return recencyToStartDate(filter, now);
}

/** Google-style `tbs=qdr:` time window — Firecrawl `/search` `tbs` param and
 *  the bsk channel's google navigation share the same format. */
export function recencyToTbs(filter: RecencyFilter): string {
	return `qdr:${filter[0]}`; // day → qdr:d, week → qdr:w, month → qdr:m, year → qdr:y
}
