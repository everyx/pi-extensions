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
 */

import { homedir } from "node:os";
import { sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { firstLine, formatDuration, SPINNER, safeTitle } from "./format.js";
import type { NotificationDetails, RenderEvent, SubagentDetails, Truncation } from "./types.js";

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
	/** Spinner frame index for the stop/start animation. */
	frame?: number;
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

/** Muted metadata suffix, mirroring bash's ` (timeout 10s)` pattern. */
function buildMetaSuffix(
	model: string | undefined,
	thinking: string | undefined,
	time: string | undefined,
	theme: Theme,
): string {
	const parts: string[] = [];
	if (model) parts.push(model);
	if (thinking) parts.push(thinking);
	if (time) parts.push(time);
	if (parts.length === 0) return "";
	return theme.fg("muted", ` (${parts.join(" \u00b7 ")})`);
}

// ── Render call (tool header) ──────────────────────────────────

export function renderAgentCall(args: AgentParams, theme: Theme, context: RenderContext): Text {
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}

	// Background spawn: no header — a single status line renders from
	// renderResult (Text("") renders zero lines); the title lives on the line.
	if (args.run_in_background) return new Text("", 0, 0);

	// Status icon, fronted like every other surface: the accent spinner while
	// running (same width as ✓/✗, so the `Agent` column never shifts), then
	// ✓/✗ on completion (the framework marks the result via isError).
	const icon = context.isPartial
		? (() => {
				const state = context.state as TimerState & { frame?: number };
				state.frame = (state.frame ?? 0) + 1;
				return theme.fg("accent", SPINNER[state.frame % SPINNER.length]);
			})()
		: context.isError
			? theme.fg("error", "\u2717")
			: theme.fg("success", "\u2713");

	// Elapsed/Took rides the header meta (shared state carries the timestamps;
	// the endedAt fallback keeps the first final frame correct even though the
	// result renderer writes the precise value one render later).
	const timePart =
		context.state.startedAt === undefined
			? undefined
			: `${context.isPartial ? "Elapsed" : "Took"} ${formatDuration((context.state.endedAt ?? Date.now()) - (context.state.startedAt as number))}`;

	const title = safeTitle(args.title.trim() || firstLine(args.prompt));
	const state = context.state as TimerState;
	// Resolved model/thinking from the first onUpdate carry-back (renderCall
	// runs before execute() so args.model/thinking are the raw user inputs).
	const metaModel = state.resolvedModel ?? args.model;
	const metaThinking = state.resolvedThinking ?? args.thinking;
	return new Text(
		`${icon} ${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("bashMode", `"${title}"`)}${buildMetaSuffix(metaModel, metaThinking, timePart, theme)}`,
		0,
		0,
	);
}

export function renderAgentControlCall(_args: AgentControlParams, _theme: Theme, _context: RenderContext): Text {
	// Steer/stop render as single working-indicator status lines from
	// renderResult — no header (Text("") renders zero lines).
	return new Text("", 0, 0);
}

// ── Render result (output body) ────────────────────────────────

/** Dim one-liner for background-start/control acks and bare errors. */
function dimOneLiner(text: string | undefined, theme: Theme): Text {
	if (!text) return new Text("", 0, 0);
	return new Text(theme.fg("dim", text), 0, 0);
}

/**
 * One-line agent status: `[marker] Agent "title" <state>` — the shared shape
 * for background-start / steer / stop lines. The state is a natural-language
 * verb phrase ("started", "starting…") joined with a plain space — the
 * `·` separator is reserved for data (widget elapsed time, notification meta)
 * so it never splits a phrase. `Agent` keeps the tool-card
 * header style (toolTitle bold); the quoted title uses bashMode like the
 * bash card's `$ cmd`. The marker is a status icon (accent spinner while
 * running / success ✓ / error ✗) so the state reads at a glance. Failure
 * reasons are rendered separately (dim second line) — not in this line.
 */
function statusLine(
	title: string | undefined,
	verb: "start" | "steer" | "stop" | "control",
	phase: "running" | "done" | "failed",
	theme: Theme,
	spinner?: string,
): string {
	const agent = `${theme.fg("toolTitle", theme.bold("Agent"))}${title ? ` ${theme.fg("bashMode", `"${safeTitle(title)}"`)}` : ""}`;
	const marker =
		phase === "running"
			? theme.fg("accent", spinner ?? "")
			: phase === "failed"
				? theme.fg("error", "\u2717")
				: theme.fg("success", "\u2713");
	if (phase === "failed") {
		return `${marker} ${agent} ${theme.fg("error", `${verb} failed`)}`;
	}
	const state =
		phase === "running"
			? verb === "start"
				? "starting…"
				: "stopping…"
			: verb === "start"
				? "started"
				: verb === "stop"
					? "stopped"
					: verb === "steer"
						? "steered"
						: "finished";
	return `${marker} ${agent} ${theme.fg("muted", state)}`;
}

export type { RenderEvent } from "./types.js";

/**
 * Shared output body: the prompt and the sub-agent's activity stream are one
 * stream — the prompt rides at the head and flows away as output grows
 * (terminal-scroll feel; the header title is the card's fixed identifier).
 * Events render in order with their pi-native styles (Thinking... italic,
 * tool calls toolTitle, text in toolOutput). Collapsed folds the stream to
 * the tail PREVIEW_LINES with an "N earlier lines" hint; expanded shows
 * everything. Returns null when there is nothing to show.
 */
type BodyComponent = Text | Container | { invalidate: () => void; render: (w: number) => string[] };

/** Output preview line limit when collapsed. */
const PREVIEW_LINES = 5;

/**
 * Content row below a header/footer: a leading blank line separates it
 * (bash card parity). Must be a literal `\n` inside the text — an empty
 * Text (Text("")/Text("\n")) renders ZERO lines in pi-tui, so a bare gap
 * would vanish; `\n` + content renders "blank line + content".
 */
function contentRow(styled: string, x = 0): Text {
	return new Text(`\n${styled}`, x, 0);
}

/**
 * Context-truncation warning (bash parity): only the Truncated clause —
 * the session path lives separately in the card footer so the warning
 * never duplicates it.
 */
function truncationWarning(truncation: Truncation, theme: Theme): string {
	if (!truncation.truncated) return "";
	if (truncation.truncatedBy === "lines") {
		return `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
	}
	return `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit)]`;
}

/**
 * Card content block with uniform folding: short content renders in full
 * (blank line + content); content past PREVIEW_LINES folds to a tail preview
 * with the expand hint (Ctrl+O to expand reveals everything — folding never
 * loses content, it only caps how much fills the screen). Shared by every
 * card body so the fold behavior is identical across surfaces.
 */
function foldedBlock(styledRows: string[], theme: Theme): BodyComponent {
	// Short content resolves through truncateToVisualLines with zero skipped
	// lines (so a single prompt that wraps across many visual rows still folds
	// correctly); only the fold hint distinguishes short from long.
	const body = styledRows.join("\n");
	return {
		invalidate: () => {},
		render: (w: number) => {
			const preview = truncateToVisualLines(body, PREVIEW_LINES, w, 0);
			if (preview.skippedCount === 0) return ["", ...preview.visualLines];
			// Same hint as pi's core/tools/bash.js result card:
			// `... (N earlier lines, KEY to expand)` — paren wraps the whole phrase.
			const hint = `${theme.fg("muted", `... (${preview.skippedCount} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			return ["", truncateToWidth(hint, w, "..."), ...preview.visualLines];
		},
	};
}

/** foldedBlock over a single colored string (split per line so colors survive folding). */
function foldedContent(styled: string, color: (line: string) => string, theme: Theme): BodyComponent {
	return foldedBlock(styled.split("\n").map(color), theme);
}

/** Style one body row per its kind (pi-native colors). */
function styleRow(row: { style: "prompt" | "thinking" | "tool" | "text"; content: string }, theme: Theme): string {
	switch (row.style) {
		case "thinking":
			return theme.italic(theme.fg("thinkingText", "Thinking..."));
		case "tool": {
			const sepIdx = row.content.indexOf(":");
			if (sepIdx === -1) return theme.fg("toolTitle", row.content);
			return `${theme.fg("toolTitle", row.content.slice(0, sepIdx))}${theme.fg("muted", row.content.slice(sepIdx))}`;
		}
		default:
			return theme.fg("toolOutput", row.content);
	}
}

/** Flatten prompt + events into styled rows (text chunks split per line). */
function bodyRows(
	input: string | undefined,
	events: RenderEvent[] | undefined,
): { style: "prompt" | "thinking" | "tool" | "text"; content: string }[] {
	const rows: { style: "prompt" | "thinking" | "tool" | "text"; content: string }[] = [];
	const promptText = input?.trim();
	if (promptText) {
		rows.push({ style: "prompt", content: promptText });
		if (events?.length) rows.push({ style: "text", content: "" }); // blank line after the prompt
	}
	for (const ev of events ?? []) {
		if (ev.kind === "thinking") {
			rows.push({ style: "thinking", content: "Thinking..." });
		} else if (ev.kind === "tool") {
			rows.push({ style: "tool", content: `${ev.name}:${ev.args ? ` ${ev.args}` : ""}` });
		} else {
			for (const line of ev.text.split("\n")) rows.push({ style: "text", content: line });
		}
	}
	return rows;
}

function renderBody(
	input: string | undefined,
	events: RenderEvent[] | undefined,
	expanded: boolean,
	theme: Theme,
): BodyComponent | null {
	const rows = bodyRows(input, events);
	if (rows.length === 0) return null;

	if (expanded) {
		const cmp = new Container();
		// First row carries the blank-line prefix (blank + content).
		cmp.addChild(contentRow(styleRow(rows[0], theme)));
		for (const row of rows.slice(1)) cmp.addChild(new Text(styleRow(row, theme), 0, 0));
		return cmp;
	}

	// Collapsed: uniform fold — short content in full, long content tail-5
	// preview + expand hint (same foldedBlock as every other card).
	return foldedBlock(
		rows.map((r) => styleRow(r, theme)),
		theme,
	);
}

export function renderAgentResult(
	result: { details?: SubagentDetails; content: { type: string; text?: string }[] },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Container | Text {
	const details = result.details;
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	// Background spawn: `starting…` spinner in a pending card → a result card
	// (`✓ started` / `✗ start failed` + dim reason). Every phase carries the
	// card shell (pending → success/error) so the tool never flashes a bare
	// Loader-style spinner that could be mistaken for pi's own.
	if (details?.runInBackground && !details.task) {
		const state = context.state;
		if (isPartial && !details.error) {
			// Spinner animation inside the pending card (in-place, no new lines).
			if (state.frame === undefined) state.frame = 0;
			if (!state.interval) state.interval = setInterval(() => context.invalidate(), 100);
			const spinner = SPINNER[state.frame % SPINNER.length];
			state.frame++;
			const cmp = new Box(1, 1, (t: string) => theme.bg("toolPendingBg", t));
			cmp.addChild(new Text(statusLine(details.title, "start", "running", theme, spinner), 0, 0));
			return cmp;
		}
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
		if (details.error) {
			const cmp = new Box(1, 1, (t: string) => theme.bg("toolErrorBg", t));
			cmp.addChild(new Text(statusLine(details.title, "start", "failed", theme), 0, 0));
			// Full reason, never truncated — wraps inside the card instead. A
			// blank line separates content from the header like every other card;
			// content starts at the card edge (no header-column alignment).
			cmp.addChild(foldedContent(details.error, (l) => theme.fg("dim", l), theme));
			return cmp;
		}
		const cmp = new Box(1, 1, (t: string) => theme.bg("toolSuccessBg", t));
		cmp.addChild(new Text(statusLine(details.title, "start", "done", theme), 0, 0));
		return cmp;
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
		state.interval = setInterval(() => context.invalidate(), 100);
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= details?.endedAt ?? Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}

	const cmp = new Container();
	const promptText = details.task.trim();

	// Body: the prompt plus the ordered activity stream (thinking / tool
	// calls / streamed text) — like replaying the sub-agent's session.
	const body = renderBody(promptText, details.events, expanded, theme);
	if (body) cmp.addChild(body);

	// Context-truncation warning (below body, before the session footer).
	if (details?.truncation?.truncated && !isPartial) {
		cmp.addChild(contentRow(theme.fg("warning", truncationWarning(details.truncation, theme))));
	}
	// Footer: session path — resume entry (sub-agent sessions live outside
	// `pi -r`). Shown for both success and failure so the user (and LLM)
	// can always recover the full output.
	if (details?.sessionPath && !isPartial) {
		cmp.addChild(contentRow(theme.fg("muted", `session: ${shortenHome(details.sessionPath)}`)));
	}

	return cmp;
}

export interface AgentControlDetails {
	agentId?: string;
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
	// `expanded` is accepted by the renderer contract but unused here — status
	// lines never fold.
	{ isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Container | Text {
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	const d = result.details;

	const verb = d?.action === "steer" ? "steer" : d?.action === "stop" ? "stop" : "control";

	// Final results are small cards (Box shell, error/success background like
	// the notification card); only the running phases stay bare (spinner,
	// Loader style). Errors keep the status-line shape: `✗ Agent "title"
	// <verb> failed` with the reason as a dim second line (kept out of the
	// state line so new users can read the state at a glance).
	if (d?.error) {
		// A stop that failed mid-animation must stop the spinner: the partial
		// stop frame started a 100ms interval that would otherwise invalidate
		// the display forever.
		const state = context.state;
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
		const cmp = new Box(1, 1, (t: string) => theme.bg("toolErrorBg", t));
		cmp.addChild(new Text(statusLine(d.title, verb, "failed", theme), 0, 0));
		// Full error, never truncated — a truncated reason hides the very
		// detail the user needs (e.g. the offending model name). Wraps across
		// lines inside the card, with a blank line separating it from the
		// header like every other card; content starts at the card edge.
		cmp.addChild(foldedContent(d.error, (l) => theme.fg("dim", l), theme));
		return cmp;
	}

	// Steer: status line + the injected message as a plain content line
	// (no quote styling — content renders uniformly across cards).
	if (d?.action === "steer" && d.message) {
		const cmp = new Box(1, 1, (t: string) => theme.bg("toolSuccessBg", t));
		cmp.addChild(new Text(statusLine(d.title, "steer", "done", theme), 0, 0));
		// The full message, never truncated; blank line separates it from the
		// header, content starts at the card edge (same layout as bodies).
		cmp.addChild(foldedContent(d.message, (l) => theme.fg("toolOutput", l), theme));
		return cmp;
	}

	// Stop: spinner while stopping, then a single completed card.
	if (d?.action === "stop") {
		const state = context.state;
		if (isPartial) {
			// Pending card: spinner + "Agent <title> stopping…" — the card shell
			// is present in every phase, never a bare Loader-style spinner.
			const cmp = new Box(1, 1, (t: string) => theme.bg("toolPendingBg", t));
			if (state.frame === undefined) state.frame = 0;
			if (!state.interval) state.interval = setInterval(() => context.invalidate(), 100);
			const spinner = SPINNER[state.frame % SPINNER.length];
			state.frame++;
			cmp.addChild(new Text(statusLine(d.title, "stop", "running", theme, spinner), 0, 0));
			return cmp;
		}
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
		const cmp = new Box(1, 1, (t: string) => theme.bg("toolSuccessBg", t));
		cmp.addChild(new Text(statusLine(d.title, "stop", "done", theme), 0, 0));
		return cmp;
	}

	// Bare fallback (no details) — dim one-liner.
	return dimOneLiner(text, theme);
}

// ── Notification card (registerMessageRenderer) ────────────────

export type { NotificationDetails } from "./types.js";

/** Expand `~`-style home prefix to a display path (cross-platform). */
function shortenHome(p: string): string {
	// `~` is not understood by Windows terminals (cmd/PowerShell) — keep the
	// full path there so the printed path stays copy-paste runnable.
	if (process.platform === "win32") return p;
	const home = homedir();
	if (p === home) return "~";
	return p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

export function renderNotification(
	message: { details?: NotificationDetails },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Container {
	const d = message.details;

	if (!d) {
		const cmp = new Container();
		cmp.addChild(new Text(theme.fg("dim", "(no details)"), 0, 0));
		return cmp;
	}

	// ── Header: ✓ Agent <title> <status word> (<muted meta>) ──
	// The status icon distinguishes the completion card from the Agent tool
	// card (which has no icon): ✓ success / ✗ error / ■ stopped. Background
	// color still conveys state (Pi native); failed/stopped words are colored
	// like bash's `(exit N)` / `(cancelled)`.
	const isError = d.status !== "completed";
	const cmp = new Box(1, 1, (text: string) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));

	const icon = d.status === "completed" ? "\u2713" : d.status === "failed" ? "\u2717" : "\u25a0";
	const iconColor = d.status === "completed" ? "success" : d.status === "failed" ? "error" : "warning";

	const statusWord =
		d.status === "failed"
			? ` ${theme.fg("error", d.status)}`
			: d.status === "stopped"
				? ` ${theme.fg("warning", d.status)}`
				: "";

	const metaParts: string[] = [];
	if (d.model) metaParts.push(d.model);
	if (d.thinking) metaParts.push(d.thinking);
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);
	const metaSuffix = metaParts.length > 0 ? theme.fg("muted", ` (${metaParts.join(" \u00b7 ")})`) : "";

	cmp.addChild(
		new Text(
			`${theme.fg(iconColor as "success" | "error" | "warning", icon)} ${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("bashMode", `"${safeTitle(d.title)}"`)}${statusWord}${metaSuffix}`,
			0,
			0,
		),
	);

	// ── Body: result preview — same fold policy as tool cards (input full,
	// output tail + "earlier lines" hint, full text when expanded). ──
	const result = d.result?.trim();
	if (result) {
		// Notification body is plain text — a single text event.
		const body = renderBody(undefined, [{ kind: "text", text: result }], expanded, theme);
		if (body) cmp.addChild(body);
	}

	// ── Context-truncation warning (below body, before the session footer) ──
	if (d.truncation?.truncated) {
		cmp.addChild(contentRow(theme.fg("warning", truncationWarning(d.truncation, theme))));
	}
	// ── Footer: session path (resume entry, custom dir → path required) ──
	if (d.sessionPath) {
		cmp.addChild(contentRow(theme.fg("muted", `session: ${shortenHome(d.sessionPath)}`)));
	}

	return cmp;
}
