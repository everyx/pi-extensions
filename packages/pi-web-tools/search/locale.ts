/**
 * pi-web-tools — engine priority within the enabled set (SPEC: 本地化).
 *
 * Ordering for the bsk engine when auto-routing with a locale: the
 * localization-specialist first, then google as the global fallback.
 * Applied to the *enabled* set only (defaults: zh → bing,google;
 * ru → yandex,google; everything else → google). Engines outside a
 * default set (e.g. baidu) take their priority position here only when
 * explicitly enabled via PI_WEB_TOOLS_ENGINES. Locale itself is explicit
 * (LLM-passed, never inferred from the query). Pure, unit-testable.
 */

import type { EngineId } from "../types.js";

/** BCP-47 → language-group engine priority, first group match wins (order
 * matters). Applied within the enabled engine set — see file header. */
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

/** Real navigation host for a browser engine + locale (single source of
 * truth for the search URL). bing is served from cn.bing.com for zh-CN
 * (separate CN data source); yandex from yandex.ru for Russian. */
export function engineHost(engine: EngineId, locale?: string): string {
	switch (engine) {
		case "google":
			return "www.google.com";
		case "bing":
			return isZhCn(locale) ? "cn.bing.com" : "www.bing.com";
		case "baidu":
			return "www.baidu.com";
		case "yandex":
			return primaryLanguage(locale) === "ru" ? "yandex.ru" : "yandex.com";
	}
}

/** Bare domain identity for the via label (engineHost minus the www.). */
export function engineDomain(engine: EngineId, locale?: string): string {
	return engineHost(engine, locale).replace(/^www\./, "");
}

/** True for the zh-CN locale (mainland data source — cn.bing.com). */
function isZhCn(locale?: string): boolean {
	return primaryLanguage(locale) === "zh" && countryFromLocale(locale) === "CN";
}

/** Meta label for the channel a search went through (shared by index.ts and
 * the 1:1 preview). Browser engines are labeled by the domain actually
 * navigated (via cn.bing.com); api channels by name (via exa). */
export function viaLabel(channel?: string, engine?: string, locale?: string): string | undefined {
	if (!channel) return undefined;
	if (channel === "bsk" && engine) return `via ${engineDomain(engine as EngineId, locale)}`;
	return `via ${channel}`;
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
			return { url: `https://${engineHost("google")}/search?q={q}`, localeParams: params };
		}
		case "bing": {
			const params: Record<string, string> = {};
			if (locale) params.mkt = normalizedLocale(locale); // Bing eats BCP-47 directly
			if (recency) params.filters = recencyToBingFilters(recency);
			return { url: `https://${engineHost("bing", locale)}/search?q={q}`, localeParams: params };
		}
		case "baidu":
			// Baidu is natively Chinese; no locale params needed.
			return { url: `https://${engineHost("baidu")}/s?wd={q}` };
		case "yandex": {
			const params: Record<string, string> = {};
			if (lang === "ru") params.lr = "213"; // Moscow region for Russian
			return { url: `https://${engineHost("yandex", locale)}/search/?text={q}`, localeParams: params };
		}
	}
}

/**
 * Bing web UI freshness filter: filters=ex1:"ez1"…"ez4"
 * (ez1=24h, ez2=week, ez3=month, ez4=year — scraper convention).
 */
function recencyToBingFilters(recency: string): string {
	const code = { day: "ez1", week: "ez2", month: "ez3", year: "ez4" }[recency] ?? "ez4";
	return `ex1:"${code}"`;
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
