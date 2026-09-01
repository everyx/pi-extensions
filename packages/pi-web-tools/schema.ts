/**
 * pi-web-tools — tool parameter schemas (TypeBox).
 *
 * The web_search surface is the four-API-channel intent intersection (the bsk no-key fuse rides the same surface): query,
 * recency, domain filters — plus locale as an explicit best-effort override.
 * Descriptions are minimal by principle: anything the LLM can self-serve
 * (param names, enum values, the returned result shape) carries no copy;
 * only contracts that cannot be inferred (bare-hostname format, locale
 * semantics) are written down. Behavioral steering (query language) lives
 * in the tool's promptGuidelines — single source, no duplication.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export function buildWebSearchSchema() {
	return Type.Object({
		query: Type.String(),
		recency: Type.Optional(StringEnum(["day", "week", "month", "year"])),
		allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Bare hostnames, e.g. github.com." })),
		blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Bare hostnames, e.g. reddit.com." })),
		locale: Type.Optional(
			Type.String({
				description:
					"Prefer results for this language/region (BCP-47, e.g. zh-CN) — best-effort: " +
					"a language/market boost where the provider supports it. Omit for results " +
					"matching the query's language.",
			}),
		),
	});
}

export const WebFetchParamsSchema = Type.Object({
	url: Type.String({ description: "The http(s) URL to fetch." }),
	raw: Type.Optional(
		Type.Boolean({
			description:
				"Return the raw source instead (HTML stays HTML; non-HTML " + "JSON/XML/plain text returns as-is either way).",
		}),
	),
});

export type WebFetchParams = { url: string; raw?: boolean };
