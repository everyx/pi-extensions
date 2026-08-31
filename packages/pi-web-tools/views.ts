/**
 * Tool view definitions — single-sourced here so the production tool
 * registration (index.ts) and the dev storybook (preview.ts) can never
 * drift. Same pattern as pi-subagent's views.ts.
 */

import { durationMeta } from "@everyx/pi-ui/spinner.js";
import { createToolView, expandHintText } from "@everyx/pi-ui/view.js";
import type { FetchToolData, SearchToolData } from "./types.js";

/** Meta label for the channel a search went through. The bsk fuse is labeled
 *  by the engine domain it navigated (via baidu.com); api channels by name
 *  (via exa). */
function viaLabel(data: SearchToolData): string | undefined {
	if (!data.channel) return undefined;
	if (data.channel === "bsk" && data.engine) return `via ${data.engine}.com`;
	return `via ${data.channel}`;
}

export const searchView = createToolView<Record<string, unknown>, SearchToolData>({
	name: "web_search",
	title: (ctx) => String((ctx.args as Record<string, unknown>).query ?? ""),
	tail: (ctx) => (ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working\u2026" : undefined),
	meta: (ctx) => {
		const d = ctx.result?.data ?? {};
		return [
			viaLabel(d),
			// A failed search reports no result count — it's 0 by definition.
			ctx.status !== "error" && d.count != null ? `${d.count} results` : undefined,
			durationMeta(ctx.status, d.startedAt, d.endedAt),
		].filter(Boolean) as string[];
	},
	body: {
		list: {
			of: (ctx) => ctx.result?.data?.results ?? [],
			fields: ["title", "url", "snippet"],
		},
	},
});

export const fetchView = createToolView<Record<string, unknown>, FetchToolData>({
	name: "web_fetch",
	title: (ctx) => String((ctx.args as Record<string, unknown>).url ?? ""),
	tail: (ctx) => (ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working\u2026" : undefined),
	meta: (ctx) => {
		// No page title in meta — the URL already fills the header, and the
		// title would make the row far too long.
		const d = ctx.result?.data ?? {};
		const items: string[] = [];
		const dur = durationMeta(ctx.status, d.startedAt, d.endedAt);
		if (dur) items.push(dur);
		// Expand hint rides in the same meta parentheses as the duration
		// (one paren group, " · "-split — read keeps its hints out of the
		// header entirely; ours is a header-only fold, so the affordance
		// lives in the header's meta, never inside the quoted title).
		const hint = expandHintText(d);
		if (hint) items.push(hint);
		return items.length ? items : undefined;
	},
	body: { text: (ctx) => (ctx.expanded ? (ctx.result?.data?.content ?? "") : "") },
});
