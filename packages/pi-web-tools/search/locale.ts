/**
 * pi-web-tools — locale inference and engine priority (SPEC: 本地化).
 *
 * Language grouping drives the default engine order for the bsk channel:
 *   中文 → bing > baidu > google
 *   俄语 → yandex > google > bing
 *   其他 → google > bing
 * Pure, unit-testable.
 */

import type { EngineId } from "../types.js";

/** BCP-47 → language-group engine priority. First group match wins (order matters). */
export function enginePriorityForLocale(locale?: string): EngineId[] {
	const lang = primaryLanguage(locale);
	if (lang === "zh") return ["bing", "baidu", "google"];
	if (lang === "ru") return ["yandex", "google", "bing"];
	return ["google", "bing"];
}

/** Extract the primary language subtag from a BCP-47 tag ("zh-CN" → "zh"). */
export function primaryLanguage(locale?: string): string {
	if (!locale) return "";
	const tag = locale.trim().toLowerCase();
	const sep = tag.search(/[-_]/);
	return (sep >= 0 ? tag.slice(0, sep) : tag).trim();
}

/** Search-engine URL builders for the bsk channel (SPEC: locale 落地). */
export interface EngineUrl {
	/** Base search URL (query param placeholder `{q}`). */
	url: string;
	/** Extra query params appended for the locale, when supported. */
	localeParams?: Record<string, string>;
}

/** Build a search URL for an engine + locale + optional recency. */
export function engineSearchUrl(engine: EngineId, locale?: string, recency?: string): EngineUrl {
	const lang = primaryLanguage(locale);
	switch (engine) {
		case "google": {
			const params: Record<string, string> = {};
			if (locale) {
				// gl = country, hl = UI language, lr = result language.
				params.gl = countryFromLocale(locale);
				params.hl = normalizedLocale(locale);
				params.lr = `lang_${lang}`;
			}
			if (recency) params.tbs = recency;
			return { url: "https://www.google.com/search?q={q}", localeParams: params };
		}
		case "bing": {
			const params: Record<string, string> = {};
			if (locale) params.mkt = normalizedLocale(locale); // Bing eats BCP-47 directly
			if (recency) params.filters = recency;
			return { url: "https://www.bing.com/search?q={q}", localeParams: params };
		}
		case "baidu":
			// Baidu is natively Chinese; no locale params needed.
			return { url: "https://www.baidu.com/s?wd={q}" };
		case "yandex": {
			const params: Record<string, string> = {};
			if (lang === "ru") params.lr = "213"; // Moscow region for Russian
			return { url: "https://yandex.com/search/?text={q}", localeParams: params };
		}
	}
}

/** Normalize a BCP-47 tag to the form engines expect ("zh-cn" → "zh-CN"). */
export function normalizedLocale(locale?: string): string {
	if (!locale) return "en-US";
	const [lang, region] = locale.split(/[-_]/);
	return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
}

/** Country subtag from BCP-47 ("zh-CN" → "CN", "en" → ""). */
export function countryFromLocale(locale?: string): string {
	if (!locale) return "";
	const parts = locale.split(/[-_]/);
	return parts.length > 1 ? (parts[1] ?? "").toUpperCase() : "";
}
