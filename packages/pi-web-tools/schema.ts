/**
 * pi-web-tools — tool parameter schemas (TypeBox).
 *
 * Two primitives (SPEC 工具面): web_search with optional structured filters
 * + engine gate; web_fetch with a single url.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { EngineId } from "./types.js";

/**
 * Build the web_search parameter schema.
 *
 * The engine enum mirrors the enabled set resolved at startup (SPEC: 枚举即
 * 事实) — the LLM only ever sees engines that are actually usable, so there
 * are no dead options and no "engine not enabled" errors at call time.
 * Locale is explicit (LLM passes it when it wants localized results) — the
 * tool never guesses a language from the query.
 */
export function buildWebSearchSchema(engines: EngineId[]) {
	const engineValues = ["auto", ...engines] as const;
	return Type.Object({
		query: Type.String({
			description:
				"Search query. Natural language for auto routing. When you set engine to a " +
				"real browser engine (google/bing/baidu/yandex), you may use that engine's " +
				'native operators (site:, filetype:, intitle:, -exclude, "exact phrase", OR).',
		}),
		recency: Type.Optional(
			StringEnum(["day", "week", "month", "year"], {
				description:
					"Only results from this time window. Unsupported by baidu/yandex — omit recency (or use auto) there.",
			}),
		),
		allowed_domains: Type.Optional(
			Type.Array(Type.String(), {
				description: 'Only search within these domains (e.g. ["github.com", "developer.mozilla.org"]).',
			}),
		),
		blocked_domains: Type.Optional(
			Type.Array(Type.String(), {
				description: 'Exclude these domains from results (e.g. ["reddit.com"]).',
			}),
		),
		locale: Type.Optional(
			Type.String({
				description:
					"BCP-47 locale (e.g. zh-CN, en-US, ru-RU) for localized results. Routes to a " +
					"real-browser engine that serves the local edition (zh-CN → cn.bing.com). " +
					"Omit for global results.",
			}),
		),
		engine: Type.Optional(
			StringEnum(engineValues, {
				description:
					"auto (default): pick the best engine automatically. google/bing/baidu/yandex: " +
					"search a real browser engine with its native operator syntax — operator and " +
					"locale support varies by engine (baidu has no locale handling). The listed " +
					"engines are the ones enabled in this install.",
			}),
		),
	});
}

export const WebFetchParamsSchema = Type.Object({
	url: Type.String({ description: "The http(s) URL to fetch." }),
	raw: Type.Optional(
		Type.Boolean({
			description:
				"Return the raw source instead of converted Markdown (HTML stays HTML, " +
				"nothing is ever wrapped or decorated). " +
				"Default false: HTML pages are converted to Markdown; non-HTML (JSON/XML/plain text) " +
				"is always returned as-is either way.",
		}),
	),
});

export type WebFetchParams = { url: string; raw?: boolean };
