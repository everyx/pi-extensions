/**
 * pi-web-tools — recency mapping (SPEC: 跨通道映射).
 *
 * Each channel translates `recency: "day" | "week" | "month" | "year"`
 * into its native expression. Pure, unit-testable.
 */

export type RecencyFilter = "day" | "week" | "month" | "year";

export const RECENCY_FILTERS: readonly RecencyFilter[] = ["day", "week", "month", "year"];

const DAYS: Record<RecencyFilter, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

/** Days covered by a recency filter (for APIs that take a day count). */
export function recencyToDays(filter: RecencyFilter): number {
	return DAYS[filter];
}

/** ISO date (YYYY-MM-DD) N days ago — for APIs that take startPublishedDate / after_date. */
export function recencyToStartDate(filter: RecencyFilter, now: Date = new Date()): string {
	const d = new Date(now.getTime() - DAYS[filter] * 86_400_000);
	return d.toISOString().slice(0, 10);
}

/** Tavily `time_range` values. */
export function recencyToTavily(filter: RecencyFilter): string {
	return filter; // Tavily accepts day | week | month | year verbatim
}

/** Parallel `after_date` (ISO date). */
export function recencyToParallel(filter: RecencyFilter, now?: Date): string {
	return recencyToStartDate(filter, now);
}

/** Exa `startPublishedDate` (ISO date). */
export function recencyToExa(filter: RecencyFilter, now?: Date): string {
	return recencyToStartDate(filter, now);
}

/** Google `tbs=qdr:` time window (bsk channel). */
export function recencyToGoogle(filter: RecencyFilter): string {
	return `qdr:${filter[0]}`; // day → qdr:d, week → qdr:w, month → qdr:m, year → qdr:y
}

/** Human phrase used to enrich query text for engines without a native recency param. */
export function recencyToPhrase(filter: RecencyFilter): string {
	switch (filter) {
		case "day":
			return "past 24 hours";
		case "week":
			return "past week";
		case "month":
			return "past month";
		case "year":
			return "past year";
	}
}
