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
import { getMarkdownTheme, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentActivity } from "./agent-process.js";

/** Spinner frames shared by the Agents widget and the stop animation. */
export const SPINNER = [
	"\u281b",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283c",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280f",
];

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
}

export interface AgentControlParams {
	agent_id: string;
	/** Rendered as-is; execute() validates the literal at runtime (schema is StringEnum). */
	action: string;
	message?: string;
}

// ─── Tool details (returned to pi's details: T) ────────────────

export interface SubagentDetails {
	task?: string;
	agentId?: string;
	/** Agent title — used by the background-start status line (the tool header is empty for background). */
	title?: string;
	model?: string;
	runInBackground?: boolean;
	/** Spawn failure reason — rendered as `start failed: <reason>` on the status line. */
	error?: string;
	sessionPath?: string;
	startedAt?: number;
	endedAt?: number;
	/** Latest activity (thinking/tool) for the live card rows — widget parity. */
	activity?: AgentActivity;
}

// ─── Timer state persisted via context.state ───────────────────

interface TimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	/** Spinner frame index for the stop/start animation. */
	stopFrame?: number;
}

// ─── Render context (from pi framework) ────────────────────────

interface RenderContext {
	state: TimerState;
	invalidate: () => void;
	executionStarted: boolean;
	isError: boolean;
	toolCallId?: string;
}

/** Seconds with one decimal — shared by cards and the Agents widget. */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** "bash: sleep 20" → { name: "bash", args: "sleep 20" }; null when no label. */
/** Activity excerpt length cap; long tails get a leading ellipsis. */
const ACTIVITY_EXCERPT_MAX = 60;

/** Collapse whitespace, trim, and cut long tails to `max` chars (ellipsis prefix). */
export function truncateTail(s: string, max: number = ACTIVITY_EXCERPT_MAX): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `\u2026${clean.slice(clean.length - max + 1)}`;
}

/**
 * One activity row: "Thinking..." (pi hidden-thinking style), a tool call
 * (toolTitle name + ": " + muted args), or muted text. Shared by the tool
 * card activity row and the Agents widget — single source of truth so the
 * two surfaces can never drift apart. Pass `max` to truncate long tails
 * (widget); the card passes none and shows the full text.
 */
export function activityRow(activity: AgentActivity, theme: Theme, max?: number): string {
	if (activity.kind === "thinking") {
		return theme.italic(theme.fg("thinkingText", "Thinking..."));
	}
	if (activity.kind === "tool") {
		const args = max === undefined ? activity.args : truncateTail(activity.args, max);
		return args
			? `${theme.fg("toolTitle", activity.name)}: ${theme.fg("muted", args)}`
			: theme.fg("toolTitle", activity.name);
	}
	return theme.fg("muted", max === undefined ? activity.text : truncateTail(activity.text, max));
}

/** Extract a one-line summary of a long string: first line, ellipsis if truncated. */
function firstLine(s: string): string {
	const idx = s.indexOf("\n");
	return idx < 0 ? s : `${s.slice(0, idx)}\u2026`;
}

/** Muted metadata suffix, mirroring bash's ` (timeout 10s)` pattern. */
function buildMetaSuffix(args: AgentParams, theme: Theme): string {
	const parts: string[] = [];
	if (args.run_in_background) parts.push("background");
	const model = args.model;
	if (model) parts.push(model);
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

	const title = args.title.trim() || firstLine(args.prompt);
	return new Text(
		`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("toolTitle", title)}${buildMetaSuffix(args, theme)}`,
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
 * One-line agent status: `[⠋] Agent <title> · <state>` — the shared shape for
 * background-start / steer / stop lines. `Agent` and `<title>` keep the
 * tool-card header style; the state word is muted (running/done) or error
 * (failed, with a muted reason). The optional spinner animates in place —
 * never appending lines (pi/CC spinner discipline).
 */
function statusLine(
	title: string | undefined,
	verb: "start" | "steer" | "stop",
	phase: "running" | "done" | "failed",
	theme: Theme,
	spinner?: string,
	reason?: string,
): string {
	const agent = `${theme.fg("toolTitle", theme.bold("Agent"))}${title ? ` ${theme.fg("toolTitle", title)}` : ""}`;
	const head = spinner ? `${theme.fg("accent", spinner)} ${agent}` : agent;
	if (phase === "failed") {
		const note = reason ? `: ${theme.fg("muted", reason)}` : "";
		return `${head} ${theme.fg("error", `· ${verb} failed`)}${note}`;
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
					: "steered";
	return `${head} ${theme.fg("muted", `· ${state}`)}`;
}

/**
 * Shared output body: the prompt and the output are one stream — the prompt
 * rides at the head and flows away as output grows (terminal-scroll feel;
 * the header title is the card's fixed identifier). Collapsed folds the
 * stream to the tail PREVIEW_LINES with an "N earlier lines" hint; expanded
 * shows everything. Returns null when there is nothing to show.
 */
type BodyComponent = Text | { invalidate: () => void; render: (w: number) => string[] };

/** Output preview line limit when collapsed. */
const PREVIEW_LINES = 5;

function renderBody(
	input: string | undefined,
	output: string | undefined,
	expanded: boolean,
	theme: Theme,
): BodyComponent | null {
	const inputText = input?.trim();
	const outputText = output?.trim();

	// One stream: prompt (input) + blank line + output. The prompt is not
	// pinned — it flows off the top of the fold/scroll once output grows.
	const parts: string[] = [];
	if (inputText) parts.push(inputText);
	if (inputText && outputText) parts.push("");
	if (outputText) parts.push(outputText);
	const rawBody = parts.join("\n");
	if (!rawBody) return null;

	const styledBody = rawBody
		.split("\n")
		.map((l) => theme.fg("toolOutput", l))
		.join("\n");

	if (expanded) {
		// \n prefix gives 1 blank line between header and body (bash parity).
		return new Text(`\n${styledBody}`, 0, 0);
	}

	return {
		invalidate: () => {},
		render: (w: number) => {
			// Tail preview of the whole stream — goes through truncateToVisualLines
			// so long input wraps instead of crashing the TUI with an overflowing
			// rendered line.
			const preview = truncateToVisualLines(styledBody, PREVIEW_LINES, w, 0);
			if (preview.skippedCount === 0) return ["", ...preview.visualLines];
			const hint = `${theme.fg("muted", `... ${preview.skippedCount} earlier lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			return ["", hint, ...preview.visualLines];
		},
	};
}

export function renderAgentResult(
	result: { details?: SubagentDetails; content: { type: string; text?: string }[] },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Container | Text {
	const details = result.details;
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	// Background spawn: a single status line — starting… → started, or
	// `start failed: <reason>`. The agent id stays in the tool content (the
	// LLM's AgentControl handle); users only ever see the title.
	if (details?.runInBackground && !details.task) {
		const state = context.state;
		if (isPartial && !details.error) {
			// Spinner animation while the child spawns (in-place, no new lines).
			if (state.stopFrame === undefined) state.stopFrame = 0;
			if (!state.interval) state.interval = setInterval(() => context.invalidate(), 100);
			const spinner = SPINNER[state.stopFrame % SPINNER.length];
			state.stopFrame++;
			return new Text(statusLine(details.title, "start", "running", theme, spinner), 0, 0);
		}
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
		if (details.error) {
			return new Text(statusLine(details.title, "start", "failed", theme, undefined, details.error), 0, 0);
		}
		return new Text(statusLine(details.title, "start", "done", theme), 0, 0);
	}

	// Control ack / bare error — dim one-liner.
	if (!details?.task) return dimOneLiner(text, theme);

	const state = context.state;
	if (details?.startedAt !== undefined && state.startedAt === undefined) {
		state.startedAt = details.startedAt;
	}
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
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
	const output = text?.trim() ?? "";

	// Live activity rows (widget parity): thinking status and tool calls.
	// Text is already streaming as the card body, so only non-text kinds show.
	const activity = details.activity;
	if (isPartial && activity && activity.kind !== "text") {
		cmp.addChild(new Text(`\n${activityRow(activity, theme)}`, 0, 0));
	}

	// Body: prompt (input) + blank line + final output.
	const body = renderBody(promptText, output, expanded, theme);
	if (body) cmp.addChild(body);

	if (state.startedAt !== undefined) {
		const label = isPartial ? "Elapsed" : "Took";
		const endTime = state.endedAt ?? Date.now();
		cmp.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`)}`, 0, 0));
	}

	// Resume entry: sub-agent sessions live outside `pi -r` — show the path.
	if (details?.sessionPath && !isPartial) {
		cmp.addChild(new Text(theme.fg("muted", `session: ${shortenHome(details.sessionPath)}`), 0, 0));
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
	/** Failure reason — rendered as `· <verb> failed: <reason>` on the status line. */
	error?: string;
}

/**
 * Steer/stop render as single status lines (no card shell — renderShell
 * "self"): `Agent <title> · steered` + the injected message as a pi-native
 * markdown quote; stop animates `⠋ Agent <title> · stopping…` → `Agent
 * <title> · stopped`. Errors keep the same line shape with the error color.
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

	const verb = d?.action === "steer" ? "steer" : "stop";

	// Errors keep the status-line shape: `Agent <title> · <verb> failed: <reason>`.
	// renderShell "self" has no Box, so the line carries its own left padding
	// (1) and a bottom Spacer for breathing room (Box paddingY parity).
	if (d?.error) {
		const cmp = new Container();
		cmp.addChild(new Text(statusLine(d.title, verb, "failed", theme, undefined, d.error), 1, 0));
		cmp.addChild(new Spacer(1));
		return cmp;
	}

	// Steer: status line + the injected message as a pi-native markdown quote.
	if (d?.action === "steer" && d.message) {
		const cmp = new Container();
		cmp.addChild(new Text(statusLine(d.title, "steer", "done", theme), 1, 0));
		const first = d.message.trim().split(/\n/)[0];
		const line = truncateTail(first, 60);
		if (line) {
			cmp.addChild(new Markdown(`> ${line}`, 1, 0, getMarkdownTheme()));
		}
		cmp.addChild(new Spacer(1));
		return cmp;
	}

	// Stop: spinner while stopping, then a single completed line.
	if (d?.action === "stop") {
		const state = context.state;
		const cmp = new Container();
		if (isPartial) {
			// Working-indicator style: spinner + "Agent <title> · stopping…"
			// (same accent spinner / cadence as pi's Loader).
			if (state.stopFrame === undefined) state.stopFrame = 0;
			if (!state.interval) state.interval = setInterval(() => context.invalidate(), 100);
			const spinner = SPINNER[state.stopFrame % SPINNER.length];
			state.stopFrame++;
			cmp.addChild(new Text(statusLine(d.title, "stop", "running", theme, spinner), 1, 0));
		} else {
			if (state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}
			cmp.addChild(new Text(statusLine(d.title, "stop", "done", theme), 1, 0));
		}
		cmp.addChild(new Spacer(1));
		return cmp;
	}

	// Bare fallback (no details) — dim one-liner.
	return dimOneLiner(text, theme);
}

// ── Notification card (registerMessageRenderer) ────────────────

export interface NotificationDetails {
	status: string;
	agent_id: string;
	/** Required — always passed by notifyCompletion (AgentProcess.title). */
	title: string;
	/** Final output — rendered as the card body (never enters LLM context). */
	result?: string;
	usage?: {
		tokens?: number | null;
		toolUses?: number | null;
		durationMs?: number | null;
	};
	sessionPath?: string;
	sessionId?: string;
}

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
		cmp.addChild(new Text(theme.fg("dim", "no details"), 0, 0));
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
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);
	const metaSuffix = metaParts.length > 0 ? theme.fg("muted", ` (${metaParts.join(" \u00b7 ")})`) : "";

	cmp.addChild(
		new Text(
			`${theme.fg(iconColor as "success" | "error" | "warning", icon)} ${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("toolTitle", d.title)}${statusWord}${metaSuffix}`,
			0,
			0,
		),
	);

	// ── Body: result preview — same fold policy as tool cards (input full,
	// output tail + "earlier lines" hint, full text when expanded). ──
	const result = d.result?.trim();
	if (result) {
		const body = renderBody(undefined, result, expanded, theme);
		if (body) cmp.addChild(body);
	}

	// ── Footer: session path (resume entry, custom dir → path required) ──
	if (d.sessionPath) {
		cmp.addChild(new Text(`\n${theme.fg("muted", `session: ${shortenHome(d.sessionPath)}`)}`, 0, 0));
	}

	return cmp;
}
