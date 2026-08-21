/**
 * Tool view definitions — single-sourced here so the production tool
 * registration (index.ts) and the dev storybook (preview.ts) can never
 * drift. Same pattern as pi-subagent's views.ts.
 */

import { durationMeta } from "@everyx/pi-ui/spinner.js";
import { createToolView } from "@everyx/pi-ui/view.js";
import { viaLabel } from "./search/locale.js";

export const searchView = createToolView<Record<string, unknown>, unknown>({
	name: "web_search",
	title: (ctx) => String((ctx.args as Record<string, unknown>).query ?? ""),
	tail: (ctx) => (ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working\u2026" : undefined),
	meta: (ctx) => {
		const d = (ctx.result?.data ?? {}) as {
			channel?: string;
			engine?: string;
			locale?: string;
			count?: number;
			startedAt?: number;
			endedAt?: number;
		};
		return [
			viaLabel(d.channel, d.engine, d.locale),
			// A failed search reports no result count — it's 0 by definition.
			ctx.status !== "error" && d.count != null ? `${d.count} results` : undefined,
			durationMeta(ctx.status, d.startedAt, d.endedAt),
		].filter(Boolean) as string[];
	},
	body: {
		list: {
			of: (ctx) => ((ctx.result?.data as { results?: unknown[] } | undefined)?.results ?? []) as unknown[],
			fields: ["title", "url", "snippet"],
		},
	},
});

export const fetchView = createToolView<Record<string, unknown>, unknown>({
	name: "web_fetch",
	title: (ctx) => String((ctx.args as Record<string, unknown>).url ?? ""),
	tail: (ctx) => (ctx.status === "error" ? "failed" : ctx.status === "processing" ? "working\u2026" : undefined),
	meta: (ctx) => {
		// No page title in meta — the URL already fills the header, and the
		// title would make the row far too long.
		const d = (ctx.result?.data ?? {}) as { startedAt?: number; endedAt?: number };
		const dur = durationMeta(ctx.status, d.startedAt, d.endedAt);
		return dur ? [dur] : undefined;
	},
	body: { text: (ctx) => (ctx.result?.data as { content?: string } | undefined)?.content ?? "" },
});
