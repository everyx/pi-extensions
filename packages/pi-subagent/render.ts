/**
 * pi-subagent — TUI rendering helpers.
 *
 * `renderCall` / `renderResult` are pure rendering functions for the two
 * tools (Agent / AgentControl); they don't mutate state or call back into
 * the tool. Timer behaviour mirrors pi's built-in bash tool.
 *
 * `renderNotification` renders the `subagent-notification` custom message
 * (registered via `pi.registerMessageRenderer`) into a themed card for the
 * user. The LLM sees only the JSON `content`; `details` never enter context
 * (verified against `convertToLlm` in pi's dist/core/messages.js).
 *
 * These render functions are the tool's state→config mapping layer: each one
 * turns tool details into a `CardConfig` and delegates the actual header /
 * body / footer rendering to the card component layer (card.ts).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, Text } from "@earendil-works/pi-tui";
import { type CardIcon, renderHeader, textLine } from "@everyx/pi-ui/card.js";
import type { CardBody, CardConfig } from "./card.js";
import { renderCard, renderNoDetailsCard, renderNotificationCard } from "./card.js";
import { formatDuration, Spinner } from "./format.js";
import type { NotificationDetails, SubagentDetails } from "./types.js";

// ─── Tool params ───────────────────────────────────────────

export interface AgentParams {
	prompt: string;
	/** Required 3-5 word task label — header/notification title and session name. */
	title: string;
	model?: string;
	/** Reasoning intensity ("off"…"max"); inherit the main session's level when omitted. */
	thinking?: string;
	tools?: string[];
	run_in_background?: boolean;
	/** Wall-clock limit for the whole task (ms). Omitted = no limit (the default). */
	timeoutMs?: number;
}

export interface AgentControlParams {
	agent_id: string;
	/** Rendered as-is; execute() validates the literal at runtime (schema is StringEnum). */
	action: string;
	message?: string;
}

// ─── Tool details (returned to pi's details: T) ────────────────

export type { SubagentDetails } from "./types.js";

// ─── Timer state persisted via context.state ───────────────────

interface TimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	/** Spinner animation for the stop/start animation. */
	spinner?: Spinner;
	/** Resolved model (populated by renderResult on first update). */
	resolvedModel?: string;
	/** Resolved thinking level (populated by renderResult on first update). */
	resolvedThinking?: string;
}

// ─── Render context (from pi framework) ────────────────────────

interface RenderContext {
	state: TimerState;
	invalidate: () => void;
	executionStarted: boolean;
	isError: boolean;
	isPartial?: boolean;
	toolCallId?: string;
}

// ── Render call (tool header) ──────────────────────────────────

export function renderAgentCall(args: AgentParams, theme: Theme, context: RenderContext): Text {
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}

	// Background spawn: no header — a single status line renders from
	// renderResult (Text("") renders zero lines); the title lives on the line.
	if (args.run_in_background) return textLine("");

	// Status icon, fronted like every other surface: the accent spinner while
	// running (same width as ✓/✗, so the `Agent` column never shifts), then
	// ✓/✗ on completion (the framework marks the result via isError).
	const icon: CardIcon = context.isPartial
		? (() => {
				const state = context.state as TimerState & { spinner?: Spinner };
				state.spinner = state.spinner ?? new Spinner();
				return { type: "spinner", spinner: state.spinner };
			})()
		: context.isError
			? { type: "error" }
			: { type: "success" };

	// Elapsed/Took rides the header meta (shared state carries the timestamps;
	// the endedAt fallback keeps the first final frame correct even though the
	// result renderer writes the precise value one render later).
	const timePart =
		context.state.startedAt === undefined
			? undefined
			: `${context.isPartial ? "Elapsed" : "Took"} ${formatDuration((context.state.endedAt ?? Date.now()) - (context.state.startedAt as number))}`;

	const state = context.state as TimerState;
	// Resolved model/thinking from the first onUpdate carry-back (renderCall
	// runs before execute() so args.model/thinking are the raw user inputs).
	const metaModel = state.resolvedModel ?? args.model;
	const metaThinking = state.resolvedThinking ?? args.thinking;

	return textLine(
		renderHeader(
			{
				icon,
				name: "Agent",
				title: args.title.trim(),
				meta: [metaModel, metaThinking, timePart].filter((p): p is string => p !== undefined),
			},
			theme,
		),
	);
}

export function renderAgentControlCall(_args: AgentControlParams, _theme: Theme, _context: RenderContext): Text {
	// Steer/stop render as single working-indicator status lines from
	// renderResult — no header (Text("") renders zero lines).
	return textLine("");
}

// ── Render result (output body) ────────────────────────────────

/** Dim one-liner for background-start/control acks and bare errors. */
function dimOneLiner(text: string | undefined, theme: Theme): Text {
	if (!text) return textLine("");
	return textLine(theme.fg("dim", text));
}

/**
 * Result-card shape: `✗ Agent <title> <verb> failed` + dim reason — shared by
 * background-start and control failures.
 */
function errorCard(
	title: string | undefined,
	verb: "start" | "steer" | "stop" | "control",
	error: string,
	expanded: boolean,
): CardConfig {
	return {
		header: { icon: { type: "error" }, name: "Agent", title, state: { verb, phase: "failed" } },
		body: { error },
		expanded,
	};
}

/**
 * Result-card shape: `✓ Agent <title> <verb> done` — shared by start, steer
 * and stop completion (steer passes its message as the body).
 */
function doneCard(
	title: string | undefined,
	verb: "start" | "steer" | "stop",
	expanded: boolean,
	body?: CardBody,
): CardConfig {
	const config: CardConfig = {
		header: { icon: { type: "success" }, name: "Agent", title, state: { verb, phase: "done" } },
		expanded,
	};
	if (body) config.body = body;
	return config;
}

export type { RenderEvent } from "./types.js";

/**
 * Start the 80ms invalidate loop (if not running); returns the spinner
 * instance. The spinner itself is wall-clock driven (format.ts), so the
 * interval only exists to make the UI periodically repaint and reflect the
 * advancing frames/elapsed — re-renders never advance the frames.
 */
function startSpinner(state: TimerState, invalidate: () => void): Spinner {
	if (state.spinner === undefined) state.spinner = new Spinner();
	if (!state.interval) state.interval = setInterval(() => invalidate(), 80);
	return state.spinner;
}

/** Stop the invalidate loop (if running). */
function stopSpinner(state: TimerState): void {
	if (state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

export function renderAgentResult(
	result: { details?: SubagentDetails; content: { type: string; text?: string }[] },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Text | Container {
	const details = result.details;
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	// Background spawn: `starting…` spinner in a pending card → a result card
	// (`✓ started` / `✗ start failed` + dim reason). Every phase carries the
	// card shell (pending → success/error) so the tool never flashes a bare
	// Loader-style spinner that could be mistaken for pi's own. Background
	// color comes from the framework's default-shell Box (isError → error).
	if (details?.runInBackground && !details.task) {
		const state = context.state;
		if (isPartial && !details.error) {
			// Spinner animation inside the pending card (in-place, no new lines).
			return renderCard(
				{
					header: {
						icon: { type: "spinner", spinner: startSpinner(state, () => context.invalidate()) },
						title: details.title,
						state: { verb: "start", phase: "running" },
					},
					expanded,
				},
				theme,
			);
		}
		stopSpinner(state);
		if (details.error) {
			// Full reason under the uniform fold — content is never dropped, only
			// capped to the tail preview + expand hint; a blank line separates it
			// from the header like every other card.
			return renderCard(errorCard(details.title, "start", details.error, expanded), theme);
		}
		return renderCard(doneCard(details.title, "start", expanded), theme);
	}

	// Control ack / bare error — dim one-liner.
	if (!details?.task) return dimOneLiner(text, theme);

	const state = context.state;
	if (details?.startedAt !== undefined && state.startedAt === undefined) {
		state.startedAt = details.startedAt;
	}
	// Carry resolved model/thinking from first onUpdate so renderCall can
	// show them in the header meta (renderCall runs before execute()).
	if (details?.model && state.resolvedModel === undefined) state.resolvedModel = details.model;
	if (details?.thinking && state.resolvedThinking === undefined) state.resolvedThinking = details.thinking;
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 80);
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= details?.endedAt ?? Date.now();
		stopSpinner(state);
	}

	// Body: the prompt plus the ordered activity stream (thinking / tool
	// calls / streamed text) — like replaying the sub-agent's session. The
	// failure reason rides below the body (the ✗ header alone doesn't say
	// why), before the session footer.
	const body: CardBody = {
		prompt: details.task.trim(),
		events: details.events,
	};
	// Failure reason shows only in the final frame (the pending spinner card
	// has no body yet) — same dim folded style as the background-start
	// failure card.
	if (details?.error && !isPartial) body.error = details.error;

	// Footer: session path — resume entry (sub-agent sessions live outside
	// `pi -r`). Shown in every phase — streaming, success and failure — so
	// the user (and LLM) can always recover the full output; the session
	// file exists from spawn, so the entry is valid while the agent runs.
	return renderCard(
		{
			body,
			footer: details?.sessionPath ? details.sessionPath : undefined,
			expanded,
		},
		theme,
	);
}

export interface AgentControlDetails {
	/** "steer" | "stop" — validated at runtime in execute. */
	action?: string;
	/** Agent title (registered at spawn) — the UI's object identifier. */
	title?: string;
	/** The injected steer message (card body input). */
	message?: string;
	/** Failure reason — rendered as `<verb> failed: <reason>` on the status line. */
	error?: string;
}

/**
 * Steer/stop render as small result cards (Box shell, success/error
 * background); only the running phases stay bare — spinner + `Agent
 * <title> stopping…` → `Agent <title> stopped`. Errors keep the same line
 * shape with the error color, plus a dim reason line inside the card.
 */
export function renderAgentControlResult(
	result: { details?: AgentControlDetails; content: { type: string; text?: string }[] },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Text | Container {
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	const d = result.details;

	const verb = d?.action === "steer" ? "steer" : d?.action === "stop" ? "stop" : "control";

	// Final results are small cards (framework default-shell Box, error/
	// success background like every tool card); only the running phases stay
	// bare (spinner, Loader style). Errors keep the status-line shape:
	// `✗ Agent "title" <verb> failed` with the reason as a dim second line
	// (kept out of the state line so new users can read the state at a
	// glance).
	if (d?.error) {
		// A stop that failed mid-animation must stop the spinner: the partial
		// stop frame started an interval that would otherwise invalidate the
		// display forever.
		stopSpinner(context.state);
		// The reason rides the uniform fold (never dropped, only capped to a
		// tail preview + expand hint) — wrapping inside the card, blank line
		// separating it from the header like every other card.
		return renderCard(errorCard(d.title, verb, d.error, expanded), theme);
	}

	// Steer: status line + the injected message as a plain content line
	// (no quote styling — content renders uniformly across cards).
	if (d?.action === "steer" && d.message) {
		// The full message under the uniform fold (never dropped); blank line
		// separates it from the header, content starts at the card edge.
		return renderCard(doneCard(d.title, "steer", expanded, { message: d.message }), theme);
	}

	// Stop: spinner while stopping, then a single completed card.
	if (d?.action === "stop") {
		const state = context.state;
		if (isPartial) {
			// Pending card: spinner + "Agent <title> stopping…" — the card shell
			// is present in every phase, never a bare Loader-style spinner.
			return renderCard(
				{
					header: {
						icon: { type: "spinner", spinner: startSpinner(state, () => context.invalidate()) },
						name: "Agent",
						title: d.title,
						state: { verb: "stop", phase: "running" },
					},
					expanded,
				},
				theme,
			);
		}
		stopSpinner(state);
		return renderCard(doneCard(d.title, "stop", expanded), theme);
	}

	// Bare fallback (no details) — dim one-liner.
	return dimOneLiner(text, theme);
}

// ── Notification card (registerMessageRenderer) ────────────────

export type { NotificationDetails } from "./types.js";

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * Header renderer used by the tool call line (renderAgentCall): a
 * renderHeader-compatible one-liner. Kept local so card.ts stays the single
 * source for header layout while the call line reuses the same shape.
 */

export function renderNotification(
	message: { details?: NotificationDetails },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Container {
	const d = message.details;

	if (!d) {
		return renderNoDetailsCard(theme);
	}

	// ── Header: ✓ Agent <title> <status word> (<muted meta>) ──
	// The status icon distinguishes the completion card from the Agent tool
	// card (which has no icon): ✓ success / ✗ error / ■ stopped. Background
	// color still conveys state (Pi native); failed/stopped words are colored
	// like bash's `(exit N)` / `(cancelled)`.
	const isError = d.status !== "completed";

	const icon: CardIcon =
		d.status === "completed" ? { type: "success" } : d.status === "failed" ? { type: "error" } : { type: "stopped" };

	const status =
		d.status === "failed"
			? { word: d.status, color: "error" as const }
			: d.status === "stopped"
				? { word: d.status, color: "warning" as const }
				: undefined;

	const metaParts: string[] = [];
	if (d.model) metaParts.push(d.model);
	if (d.thinking) metaParts.push(d.thinking);
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);

	// ── Body: result preview — same fold policy as tool cards (input full,
	// output tail + "earlier lines" hint, full text when expanded). ──
	const body: CardBody = {};
	const result = d.result?.trim();
	if (result) {
		// Notification body is plain text — a single text event.
		body.events = [{ kind: "text", text: result }];
	}

	// Shell: the notification renders outside the tool shell (message
	// renderer), so it paints its own background; renderCard supplies the
	// header/body/footer layout shared with every tool card.
	return renderNotificationCard(
		{
			header: { icon, name: "Agent", title: d.title, status, meta: metaParts },
			body,
			footer: d.sessionPath,
			expanded,
		},
		theme,
		isError ? "error" : "success",
	);
}
