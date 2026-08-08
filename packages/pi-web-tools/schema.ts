/**
 * pi-web-tools — tool parameter schemas (TypeBox).
 *
 * Two primitives (SPEC 工具面): web_search with optional structured filters
 * + engine gate; web_fetch with a single url.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const WebSearchParamsSchema = Type.Object({
	query: Type.String({
		description:
			"Search query. Natural language for auto routing. When you set engine to a " +
			"real browser engine (google/bing/baidu/yandex), you may use that engine's " +
			'native operators (site:, filetype:, intitle:, -exclude, "exact phrase", OR).',
	}),
	recency: Type.Optional(
		StringEnum(["day", "week", "month", "year"], {
			description: "Only results from this time window. Omit for no time restriction.",
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
				'BCP-47 locale (e.g. "zh-CN", "ja-JP"). Defaults to an inference from the query ' +
				"language and your system locale.",
		}),
	),
	engine: Type.Optional(
		StringEnum(["auto", "google", "bing", "baidu", "yandex"], {
			description:
				"auto (default): pick the cheapest available channel (search APIs first). " +
				"google/bing/baidu/yandex: search with that real browser engine — enables its " +
				"native operator syntax in query (needs the browser channel available).",
		}),
	),
});

export const WebFetchParamsSchema = Type.Object({
	url: Type.String({
		description: "The http(s) URL to fetch as Markdown.",
	}),
});

export type WebSearchParams = import("./types.js").WebSearchParams;
export type WebFetchParams = { url: string };
