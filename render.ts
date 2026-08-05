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
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, SPINNER, safeTitle } from "./format.js";
import type { NotificationDetails, RenderEvent, SubagentDetails } from "./types.js";

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

	const title = args.title.trim();
	const state = context.state as TimerState;
	// Resolved model/thinking from the first onUpdate carry-back (renderCall
	// runs before execute() so args.model/thinking are the raw user inputs).
	const metaModel = state.resolvedModel ?? args.model;
	const metaThinking = state.resolvedThinking ?? args.thinking;
	return new Text(
		`${icon} ${agentTitle(title, theme)}${buildMetaSuffix(metaModel, metaThinking, timePart, theme)}`,
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
	const agent = agentTitle(title, theme);
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
 * Card background shell — Box(1, 1): 1-space horizontal padding, 1 row of
 * vertical padding top and bottom (like the framework's tool shell, so
 * notification cards match tool cards exactly). Only the notification card
 * needs it (registerMessageRenderer renders outside the tool shell); tool
 * cards get their background from the framework's default-shell Box instead
 * and must NOT wrap in card(). The blank rows are the shell's own padding —
 * content starts directly below the top padding row.
 */
function card(theme: Theme, bg: Parameters<typeof theme.bg>[0], ...children: BodyComponent[]): Box {
	const cmp = new Box(1, 1, (t: string) => theme.bg(bg, t));
	for (const child of children) cmp.addChild(child);
	return cmp;
}

/**
 * Unified card CONTENT (no background): optional header row + optional body
 * sections + optional session footer, assembled in order. Shared by every
 * card — tool results return it directly (the framework's default-shell Box
 * paints the background across header + body + footer); renderNotification
 * wraps it in card() to paint its own. Headers start at the card edge (the
 * shell's padding row precedes them); body/footer sections carry their own
 * blank-line prefix so sections read header / blank / body / blank / footer.
 * Fold/blank-line/footer behavior lives here once, so every card changes
 * together.
 */
function cardContent(theme: Theme, sections: { header?: string; body?: BodyComponent[]; footer?: string }): Container {
	const cmp = new Container();
	if (sections.header) cmp.addChild(new Text(sections.header, 0, 0));
	for (const part of sections.body ?? []) cmp.addChild(part);
	if (sections.footer) cmp.addChild(contentRow(theme.fg("muted", `session: ${shortenHome(sections.footer)}`)));
	return cmp;
}

/** Shared `Agent "title"` segment — toolTitle bold name + bashMode quoted title. */
function agentTitle(title: string | undefined, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("Agent"))}${title ? ` ${theme.fg("bashMode", `"${safeTitle(title)}"`)}` : ""}`;
}

/** Start the 100ms invalidate loop (if not running); returns the current spinner frame. */
function startSpinner(state: TimerState, invalidate: () => void): string {
	if (state.frame === undefined) state.frame = 0;
	if (!state.interval) state.interval = setInterval(() => invalidate(), 100);
	const spinner = SPINNER[state.frame % SPINNER.length];
	state.frame++;
	return spinner;
}

/** Stop the invalidate loop (if running). */
function stopSpinner(state: TimerState): void {
	if (state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

/** Error card content: failed status line + dim reason body (uniform fold). */
function statusErrorCard(
	title: string | undefined,
	verb: "start" | "steer" | "stop" | "control",
	theme: Theme,
	error: string,
	expanded: boolean,
): Container {
	return cardContent(theme, {
		header: statusLine(title, verb, "failed", theme),
		body: [contentBlock(error, (l) => theme.fg("dim", l), expanded, theme)],
	});
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

/**
 * Content block that honors the expanded flag: collapsed uses the uniform
 * fold (tail preview + expand hint); expanded renders every line in full
 * (blank-line prefix preserved in both modes — bash card parity). Content is
 * never dropped in either mode.
 */
function contentBlock(styled: string, color: (line: string) => string, expanded: boolean, theme: Theme): BodyComponent {
	if (expanded) {
		const lines = styled.split("\n");
		const cmp = new Container();
		cmp.addChild(contentRow(color(lines[0])));
		for (const line of lines.slice(1)) cmp.addChild(new Text(color(line), 0, 0));
		return cmp;
	}
	return foldedContent(styled, color, theme);
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
	// Loader-style spinner that could be mistaken for pi's own. Background
	// color comes from the framework's default-shell Box (isError → error).
	if (details?.runInBackground && !details.task) {
		const state = context.state;
		if (isPartial && !details.error) {
			// Spinner animation inside the pending card (in-place, no new lines).
			return cardContent(theme, {
				header: statusLine(
					details.title,
					"start",
					"running",
					theme,
					startSpinner(state, () => context.invalidate()),
				),
			});
		}
		stopSpinner(state);
		if (details.error) {
			// Full reason under the uniform fold — content is never dropped, only
			// capped to the tail preview + expand hint; a blank line separates it
			// from the header like every other card.
			return statusErrorCard(details.title, "start", theme, details.error, expanded);
		}
		return cardContent(theme, { header: statusLine(details.title, "start", "done", theme) });
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
		stopSpinner(state);
	}
	const promptText = details.task.trim();
	const bodyParts: BodyComponent[] = [];

	// Body: the prompt plus the ordered activity stream (thinking / tool
	// calls / streamed text) — like replaying the sub-agent's session.
	const body = renderBody(promptText, details.events, expanded, theme);
	if (body) bodyParts.push(body);

	// Failure reason (below the body, before the session footer) — the ✗
	// header alone doesn't say why; same dim folded style as the
	// background-start failure card.
	if (details?.error && !isPartial) {
		bodyParts.push(contentBlock(details.error, (l) => theme.fg("dim", l), expanded, theme));
	}
	// Footer: session path — resume entry (sub-agent sessions live outside
	// `pi -r`). Shown in every phase — streaming, success and failure — so
	// the user (and LLM) can always recover the full output; the session
	// file exists from spawn, so the entry is valid while the agent runs.
	return cardContent(theme, {
		body: bodyParts,
		footer: details?.sessionPath ? details.sessionPath : undefined,
	});
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
): Container | Text {
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
		// stop frame started a 100ms interval that would otherwise invalidate
		// the display forever.
		stopSpinner(context.state);
		// The reason rides the uniform fold (never dropped, only capped to a
		// tail preview + expand hint) — wrapping inside the card, blank line
		// separating it from the header like every other card.
		return statusErrorCard(d.title, verb, theme, d.error, expanded);
	}

	// Steer: status line + the injected message as a plain content line
	// (no quote styling — content renders uniformly across cards).
	if (d?.action === "steer" && d.message) {
		// The full message under the uniform fold (never dropped); blank line
		// separates it from the header, content starts at the card edge.
		return cardContent(theme, {
			header: statusLine(d.title, "steer", "done", theme),
			body: [contentBlock(d.message, (l) => theme.fg("toolOutput", l), expanded, theme)],
		});
	}

	// Stop: spinner while stopping, then a single completed card.
	if (d?.action === "stop") {
		const state = context.state;
		if (isPartial) {
			// Pending card: spinner + "Agent <title> stopping…" — the card shell
			// is present in every phase, never a bare Loader-style spinner.
			return cardContent(theme, {
				header: statusLine(
					d.title,
					"stop",
					"running",
					theme,
					startSpinner(state, () => context.invalidate()),
				),
			});
		}
		stopSpinner(state);
		return cardContent(theme, { header: statusLine(d.title, "stop", "done", theme) });
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
		return card(theme, "toolErrorBg", contentRow(theme.fg("dim", "(no details)")));
	}

	// ── Header: ✓ Agent <title> <status word> (<muted meta>) ──
	// The status icon distinguishes the completion card from the Agent tool
	// card (which has no icon): ✓ success / ✗ error / ■ stopped. Background
	// color still conveys state (Pi native); failed/stopped words are colored
	// like bash's `(exit N)` / `(cancelled)`.
	const isError = d.status !== "completed";

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

	const headerLine = `${theme.fg(iconColor as "success" | "error" | "warning", icon)} ${agentTitle(d.title, theme)}${statusWord}${metaSuffix}`;

	// ── Body: result preview — same fold policy as tool cards (input full,
	// output tail + "earlier lines" hint, full text when expanded). ──
	const bodyParts: BodyComponent[] = [];
	const result = d.result?.trim();
	if (result) {
		// Notification body is plain text — a single text event.
		const body = renderBody(undefined, [{ kind: "text", text: result }], expanded, theme);
		if (body) bodyParts.push(body);
	}

	// Shell: the notification renders outside the tool shell (message
	// renderer), so it paints its own background; cardContent supplies the
	// header/body/footer layout shared with every tool card.
	return card(
		theme,
		isError ? "toolErrorBg" : "toolSuccessBg",
		cardContent(theme, { header: headerLine, body: bodyParts, footer: d.sessionPath }),
	);
}
