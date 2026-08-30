/**
 * pi-web-tools — recency mapping (SPEC: 跨通道映射).
 *
 * Each channel translates `recency: "day" | "week" | "month" | "year"`
 * into its native expression. Pure, unit-testable.
 */

export type RecencyFilter = "day" | "week" | "month" | "year";

const DAYS: Record<RecencyFilter, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

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

/** Bing web UI freshness filter: filters=ex1:"ez1"…"ez4"
 *  (ez1=24h, ez2=week, ez3=month, ez4=year — scraper convention). */
export function recencyToBingFilters(filter: RecencyFilter): string {
	const code = { day: "ez1", week: "ez2", month: "ez3", year: "ez4" }[filter] ?? "ez4";
	return `ex1:"${code}"`;
}
