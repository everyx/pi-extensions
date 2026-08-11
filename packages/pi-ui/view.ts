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
import { type CardIcon, type Component, dataCard, renderHeader, type StyledRow, textLine } from "./card.js";
import { SPINNER_TICK_MS, Spinner } from "./spinner.js";
import { ticker } from "./ticker.js";

/** Structural subset of pi's ToolRenderContext (not exported at the entry). */
/** Structural match of pi's ToolRenderContext (not exported at the entry). */
interface RenderContext {
	args: unknown;
	state?: { spinner?: unknown };
	toolCallId: string;
	invalidate: () => void;
	lastComponent: unknown;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
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
	| { list: { of: (ctx: ViewContext<Args, Data>) => unknown[]; fields: string[] } }
	| {
			rows: {
				of: (ctx: ViewContext<Args, Data>) => unknown[];
				rows: Array<{
					style?: "thinking" | "tool" | "text" | "muted";
					content: (
						ctx: ViewContext<Args, Data>,
						item: unknown,
					) => string | { style: "thinking" | "tool" | "text" | "muted"; content: string };
				}>;
			};
	  };

export interface ToolView<Args, Data> {
	/** Header name slot (bold) — `web_search`, `Agent`. */
	name: string;
	/** Header title slot (quoted) — query, url, task name. */
	title?: (ctx: ViewContext<Args, Data>) => string;
	/** Header status slot — free text (starting…, start failed…), color by status. */
	tail?: (ctx: ViewContext<Args, Data>) => string | undefined;
	/** Header meta slot (muted parens, · separated). */
	meta?: (ctx: ViewContext<Args, Data>) => string[] | undefined;
	/** Body: text / result list / activity rows (folded automatically). */
	body?: ViewBody<Args, Data>;
	/** Card footer line (muted, below the folded body). */
	footer?: (ctx: ViewContext<Args, Data>) => string | undefined;
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
/** Reuse the spinner instance stored in the render state so the frames
 * animate across re-renders (time-driven: current() derives from wall clock). */
function spinnerFor(state: RenderContext["state"] | undefined): Spinner | undefined {
	const sp = (state?.spinner as Spinner | undefined) ?? new Spinner();
	if (state) state.spinner = sp;
	return sp;
}

/** One live clock-driver for a processing card (rides the render state). */
interface AnimationHandle {
	alive: boolean;
	unsubscribe(): void;
}

/** Start clock-driven redraws for a processing card: the ticker drives
 * invalidate at the spinner cadence, so the header spinner and the live
 * Elapsed meta animate on their own clock, decoupled from body content
 * streaming. Idempotent — re-renders while processing keep one driver. */
function startAnimation(rc: RenderContext, st: Record<string, unknown>): void {
	if (st.animation) return;
	const handle: AnimationHandle = { alive: true, unsubscribe: () => {} };
	handle.unsubscribe = ticker.subscribe(() => {
		// Self-healing: once the terminal render unsubscribed (or the handle
		// was replaced), stop this dead driver instead of invalidating — a
		// mid-execution destroy must never leak a ticking timer.
		if (!handle.alive || st.animation !== handle) {
			if (st.animation === handle) st.animation = undefined;
			handle.alive = false;
			handle.unsubscribe();
			return;
		}
		rc.invalidate();
	}, SPINNER_TICK_MS).unsubscribe;
	st.animation = handle;
}

/** Stop the clock-driver (terminal render — idempotent). */
function stopAnimation(st: Record<string, unknown> | undefined): void {
	if (!st) return;
	const handle = st.animation as AnimationHandle | undefined;
	if (!handle) return;
	st.animation = undefined;
	handle.alive = false;
	handle.unsubscribe();
}

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

function bodyRows<Args, Data>(
	view: ToolView<Args, Data>,
	ctx: ViewContext<Args, Data>,
): string | StyledRow[] | undefined {
	const b = view.body;
	if (!b) return undefined;
	if ("text" in b) return b.text(ctx);
	if ("list" in b) {
		return b.list
			.of(ctx)
			.map((item) => b.list.fields.map((f) => String((item as Record<string, unknown>)[f] ?? "")).join("\n"))
			.join("\n\n");
	}
	if ("rows" in b) {
		return b.rows.of(ctx).flatMap((item) =>
			b.rows.rows.flatMap((row) => {
				const out = row.content(ctx, item);
				const styled = typeof out === "string" ? { style: row.style ?? "text", content: out } : out;
				// Multi-line content becomes one StyledRow per line — the shell
				// paints the card background per row, so an embedded \n would
				// leave the lines after it without a background.
				return styled.content.split("\n").map((content) => ({ style: styled.style, content }));
			}),
		);
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
	renderCall: (args: Args, theme: Theme, context: unknown) => Component;
	renderResult: (
		result: AgentToolResult<Record<string, unknown>>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: unknown,
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
		const body = bodyRows(view, ctx);
		return dataCard(
			{
				status,
				name: view.name,
				title: view.title?.(ctx),
				tail: tailText ?? undefined,
				meta: view.meta?.(ctx),
				body,
				footer: view.footer?.(ctx),
				error: result?.error,
				expanded,
			},
			theme,
			spinner,
		);
	};

	return {
		renderCall(args, theme, context) {
			const rc = context as RenderContext;
			const status = statusForCall(rc);
			if (status === "processing") {
				// The call owns the header line while running (the result is a
				// bare body) — full header: icon + name + title + tail + meta.
				// Execution start rides the render state (set once, at the first
				// render) so the meta can show a live Elapsed timer; the result
				// renderer's data carries the same startedAt on completion.
				const st = rc.state as Record<string, unknown> | undefined;
				const startedAt = (st?.startedAt as number | undefined) ?? Date.now();
				if (st) st.startedAt = startedAt;
				// Clock-driven animation: while the call is processing, the ticker
				// invalidates this component at the spinner cadence so header
				// spinner + Elapsed meta stay smooth regardless of body stream rate.
				if (st) startAnimation(rc, st);
				// Merge the last streamed result data (if any) so the header can
				// react to activity (e.g. the running… tail) before the next
				// result render.
				const ctx = makeCtx(args, status, {
					data: { ...((st?.lastData as Partial<Data> | undefined) ?? {}), startedAt } as Data,
				});
				const tail = view.tail?.(ctx);
				return textLine(
					renderHeader(
						{
							icon: iconForStatus(status, spinnerFor(rc.state)),
							name: view.name,
							title: view.title?.(ctx),
							tail: tail ? { text: tail, color: "muted" } : undefined,
							meta: view.meta?.(ctx),
						},
						theme,
					),
				);
			}
			// Completed: the result renderer owns the surface. Stop any
			// clock-driver this call started while processing.
			stopAnimation(rc.state as Record<string, unknown> | undefined);
			return textLine("");
		},
		renderResult(result: AgentToolResult<Record<string, unknown>>, options, theme, context) {
			const rc = context as RenderContext;
			const status = statusForResult(result, rc);
			const details = (result.details ?? {}) as Partial<ViewResultData>;
			// data rides `details.data` (structured) or the details themselves
			// (flat layouts like subagent's SubagentDetails).
			const data = (details.data as Data | undefined) ?? (details as Data);
			// While running, pi renders the call and the result in the same
			// shell: the call owns the header line, so the streaming result is
			// a bare card (body only) — the header must not repeat.
			const st = rc.state as Record<string, unknown> | undefined;
			if (st) st.lastData = data; // let the call header see streamed data
			if (status === "processing") {
				const ctx = makeCtx(rc.args as Args, status, { data, error: details.error });
				return dataCard(
					{
						status,
						name: view.name,
						body: bodyRows(view, ctx),
						footer: view.footer?.(ctx),
						expanded: options.expanded,
						bare: true,
					},
					theme,
					spinnerFor(rc.state),
				);
			}
			// Terminal status: the clock-driver (if any) is done — the header
			// shows a static ✓/✗/■ and the Elapsed meta freezes as Took.
			stopAnimation(st);
			return renderCardFrom(
				status,
				rc.args as Args,
				{ data, error: details.error },
				options.expanded,
				spinnerFor(rc.state),
				theme,
			);
		},
	};
}
