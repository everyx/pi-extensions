/**
 * pi-ui — data-driven tool views.
 *
 * Declarative tool rendering: a tool declares how its result data maps onto
 * the card (name/title/tail/meta/body); pi-ui builds the renderCall and
 * renderResult from that declaration. The tool never touches rendering —
 * status (processing/success/error/stop) is derived from the framework
 * state, colors/quoting/folding live inside the card.
 *
 *   execute → structured data (in details)
 *   view    → how that data maps onto the card
 *   pi-ui   → everything else (renderers, folding, colors, status)
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type CardIcon, type Component, dataCard, renderIcon, renderNameTitle, textLine } from "./card.js";
import { Spinner } from "./spinner.js";

/** Structural subset of pi's ToolRenderContext (not exported at the entry). */
interface RenderContext {
	args: unknown;
	state?: { spinner?: unknown };
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
}

export type CardStatus = "processing" | "success" | "error" | "stop";

/** Everything a template function may need. `result` is absent while running. */
export interface ViewContext<Args, Data> {
	args: Args;
	result?: { data: Data; error?: string };
	status: CardStatus;
}

/** Structured data a tool returns for rendering (rides execute's details). */
export interface ViewResultData {
	data?: unknown;
	error?: string;
	status?: "success" | "error" | "stop";
}

/** Body template: text, a list of result rows, or a styled activity stream. */
export type ViewBody<Args, Data> =
	| { text: (ctx: ViewContext<Args, Data>) => string }
	| { list: { fields: string[] } }
	| {
			rows: Array<{
				style: "thinking" | "tool" | "text" | "muted";
				content: (ctx: ViewContext<Args, Data>, item: unknown) => string;
			}>;
	  };

export interface ToolView<Args, Data> {
	/** Header name slot (bold) — `web_search`, `Agent`. */
	name: string;
	/** Header title slot (quoted) — query, url, task name. */
	title?: (ctx: ViewContext<Args, Data>) => string;
	/** Header status slot — free text (starting…, start failed…), color by status. */
	tail?: (ctx: ViewContext<Args, Data>) => string | undefined;
	/** Header meta slot (muted parens, · separated). */
	meta?: (ctx: ViewContext<Args, Data>) => string[];
	/** Body: text / result list / activity rows (folded automatically). */
	body?: ViewBody<Args, Data>;
}

// ── status derivation (library, from framework state) ───────────

function statusForCall(context: RenderContext): CardStatus {
	return context.isPartial ? "processing" : "success";
}

function statusForResult(result: AgentToolResult<Record<string, unknown>>, context: RenderContext): CardStatus {
	if (context.isPartial) return "processing";
	const details = (result.details ?? {}) as Partial<ViewResultData>;
	if (details.status === "stop") return "stop";
	if (context.isError || details.error) return "error";
	return "success";
}

/** Map status → card icon (library decision; consumers never pass icons). */
function iconForStatus(status: CardStatus, spinner: Spinner | undefined): CardIcon {
	switch (status) {
		case "processing":
			return { glyph: (spinner ?? new Spinner()).current(), color: "accent" };
		case "error":
			return { glyph: "\u2717", color: "error" };
		case "stop":
			return { glyph: "\u25a0", color: "warning" };
		default:
			return { glyph: "\u2713", color: "success" };
	}
}

// ── body rendering (templates → text; folding is the card's job) ─

function bodyText<Args, Data>(view: ToolView<Args, Data>, ctx: ViewContext<Args, Data>): string | undefined {
	const b = view.body;
	if (!b) return undefined;
	if ("text" in b) return b.text(ctx);
	if ("list" in b) {
		const rows = Array.isArray(ctx.result?.data) ? (ctx.result.data as Record<string, unknown>[]) : [];
		return rows.map((item) => b.list.fields.map((f) => String(item[f] ?? "")).join("\n")).join("\n\n");
	}
	if ("rows" in b) {
		const items = Array.isArray(ctx.result?.data) ? (ctx.result.data as unknown[]) : [ctx.result?.data];
		return items
			.map((item) => b.rows.map((row) => row.content(ctx, item)).join("\n"))
			.filter(Boolean)
			.join("\n");
	}
	return undefined;
}

// ── the factory ─────────────────────────────────────────────────

/**
 * Build renderCall/renderResult from a declarative view. The tool provides
 * structured data (execute's details) and a view; pi-ui derives status,
 * assembles the card, and handles folding/colors/framework state.
 */
export function createToolView<Args, Data>(
	view: ToolView<Args, Data>,
): {
	renderCall: (args: Args, theme: Theme, context: RenderContext) => Component;
	renderResult: (
		result: AgentToolResult<Record<string, unknown>>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: RenderContext,
	) => Component;
} {
	const makeCtx = (
		args: Args,
		status: CardStatus,
		result?: { data: Data; error?: string },
	): ViewContext<Args, Data> => ({
		args,
		status,
		result,
	});

	const renderCardFrom = (
		status: CardStatus,
		args: Args,
		result: { data: Data; error?: string } | undefined,
		expanded: boolean,
		spinner: Spinner | undefined,
		theme: Theme,
	): Component => {
		const ctx = makeCtx(args, status, result);
		const tailText = view.tail?.(ctx);
		const body = bodyText(view, ctx);
		return dataCard(
			{
				status,
				name: view.name,
				title: view.title?.(ctx),
				tail: tailText ?? undefined,
				meta: view.meta?.(ctx),
				body,
				expanded,
			},
			theme,
			spinner,
		);
	};

	return {
		renderCall(args, theme, context) {
			const status = statusForCall(context);
			if (status === "processing") {
				return textLine(
					`${renderIcon(iconForStatus(status, context.state?.spinner as Spinner | undefined), theme)} ${renderNameTitle(view.name, view.title?.(makeCtx(args, status)), theme)}`,
				);
			}
			// Completed: the result renderer owns the surface.
			return textLine("");
		},
		renderResult(result: AgentToolResult<Record<string, unknown>>, options, theme, context) {
			const status = statusForResult(result, context);
			const details = (result.details ?? {}) as Partial<ViewResultData>;
			const data = details.data as Data | undefined;
			return renderCardFrom(
				status,
				context.args as Args,
				data === undefined ? undefined : { data, error: details.error },
				options.expanded,
				context.state?.spinner as Spinner | undefined,
				theme,
			);
		},
	};
}
