/**
 * pi-web-tools — BCP-47 parsing for locale → channel-param mapping.
 *
 * The web_search `locale` param is one intent ("prefer this language/region")
 * that each channel expresses differently: language codes, ISO country codes,
 * market enums. These helpers do the pure string math; the per-channel maps
 * live with their adapters. Pure, unit-testable.
 */

/** Extract the primary language subtag ("zh-CN" → "zh"). */
export function primaryLanguage(locale?: string): string {
	if (!locale) return "";
	const tag = locale.trim().toLowerCase();
	const sep = tag.search(/[-_]/);
	return (sep >= 0 ? tag.slice(0, sep) : tag).trim();
}

/** Country subtag ("zh-CN" → "CN", "en" → ""). */
export function countryFromLocale(locale?: string): string {
	if (!locale) return "";
	const parts = locale.trim().split(/[-_]/);
	return parts.length > 1 ? (parts[1] ?? "").toUpperCase() : "";
}

/** Fallback country for language-only locales ("ja" → JP) — channels that
 *  want a country code (exa/firecrawl) still get a sensible market. */
const DEFAULT_COUNTRY: Record<string, string> = {
	zh: "CN",
	en: "US",
	ja: "JP",
	ko: "KR",
	fr: "FR",
	de: "DE",
	es: "ES",
	pt: "BR",
	ru: "RU",
};

/** language + country intent from a BCP-47 tag. Country falls back to the
 *  language's most common market when the tag carries no region subtag. */
export function parseLocale(locale?: string): { language: string; country: string } {
	const language = primaryLanguage(locale);
	const country = countryFromLocale(locale) || DEFAULT_COUNTRY[language] || "";
	return { language, country };
}
