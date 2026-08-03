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

import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AgentActivity } from "./agent-process.js";

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
	model?: string;
	runInBackground?: boolean;
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

	const title = args.title.trim() || firstLine(args.prompt);
	return new Text(
		`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("toolTitle", title)}${buildMetaSuffix(args, theme)}`,
		0,
		0,
	);
}

export function renderAgentControlCall(args: AgentControlParams, theme: Theme): Text {
	const verb = args.action === "steer" ? "steer" : "stop";
	// Same header split as Agent cards: bold family word + plain entity.
	return new Text(
		`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("toolTitle", `${verb} ${args.agent_id}`)}`,
		0,
		0,
	);
}

// ── Render result (output body) ────────────────────────────────

/** Dim one-liner for background-start/control acks and bare errors. */
function dimOneLiner(text: string | undefined, theme: Theme): Text {
	if (!text) return new Text("", 0, 0);
	return new Text(theme.fg("dim", text), 0, 0);
}

/**
 * Shared output body, mirroring pi's bash card: the input block (prompt /
 * steer message) is always shown in full — it's the card's "command header",
 * like `$ cmd` on the bash card. The output block folds to the last
 * PREVIEW_LINES with an "N earlier lines" hint on top (bash parity); expanded
 * shows everything. Returns null when there is nothing to show.
 */
type BodyComponent = Text | { invalidate: () => void; render: (w: number) => string[] };

/** Output preview line limit when collapsed (bash's PREVIEW_LINES analog). */
const PREVIEW_LINES = 5;

function renderBody(
	input: string | undefined,
	output: string | undefined,
	expanded: boolean,
	theme: Theme,
): BodyComponent | null {
	const inputText = input?.trim();
	const outputText = output?.trim();
	if (!inputText && !outputText) return null;

	const styledInput = inputText ? theme.fg("toolOutput", inputText) : "";
	const outputLines = outputText ? outputText.split("\n") : [];
	const outputBlock = outputLines.map((l) => theme.fg("toolOutput", l)).join("\n");

	if (expanded) {
		const rows = [""];
		if (styledInput) rows.push(styledInput, "");
		if (outputBlock) rows.push(outputBlock);
		return new Text(rows.join("\n"), 0, 0);
	}

	// Collapsed: input in full; output tail preview with the hint on top.
	const previewLines = outputLines.slice(-PREVIEW_LINES);
	const hiddenCount = outputLines.length - previewLines.length;
	const styledPreview = previewLines.map((l) => theme.fg("toolOutput", l)).join("\n");
	const hint =
		hiddenCount > 0
			? `${theme.fg("muted", `... ${hiddenCount} earlier lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
			: "";

	return {
		invalidate: () => {},
		render: (w: number) => {
			const preview = truncateToVisualLines(styledPreview ? `\n${styledPreview}` : "", PREVIEW_LINES, w, 0);
			const rows: string[] = [""];
			if (styledInput) rows.push(styledInput, "");
			if (hint) rows.push(hint);
			rows.push(...preview.visualLines);
			return rows;
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

	// Background start / control ack / bare error — dim one-liner.
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
		cmp.addChild(new Text(theme.fg("muted", `session: ${details.sessionPath}`), 0, 0));
	}

	return cmp;
}

export interface AgentControlDetails {
	agentId?: string;
	/** "steer" | "stop" — validated at runtime in execute. */
	action?: string;
	/** The injected steer message (card body input). */
	message?: string;
	/** Agent's current output snapshot at steer time (card body output). */
	snapshot?: string;
}

/**
 * Steer and stop both render as full cards: header (renderCall) + optional
 * body + muted confirmation footer. Bare errors (unknown agent, bad args)
 * stay a dim one-liner — they are failures, not actions.
 */
export function renderAgentControlResult(
	result: { details?: AgentControlDetails; content: { type: string; text?: string }[] },
	{ expanded }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Container | Text {
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	const d = result.details;

	if (d?.action === "steer" && d.message) {
		const cmp = new Container();

		// Body: steer message (input, full) + blank line + agent output
		// snapshot (folded to the tail, bash-card style).
		const body = renderBody(d.message, d.snapshot, expanded, theme);
		if (body) cmp.addChild(body);

		// Footer: confirmation, muted.
		if (text) {
			cmp.addChild(new Text(`\n${theme.fg("muted", text)}`, 0, 0));
		}
		return cmp;
	}

	if (d?.action === "stop") {
		const cmp = new Container();
		// No body (nothing to show) — footer-only card, same structure as steer.
		if (text) {
			cmp.addChild(new Text(`\n${theme.fg("muted", text)}`, 0, 0));
		}
		return cmp;
	}

	// Errors — dim one-liner.
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

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

export function renderNotification(
	message: { details?: NotificationDetails },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Container {
	const d = message.details;
	const cmp = new Container();

	if (!d) {
		cmp.addChild(new Text(theme.fg("dim", "agent notification (no details)"), 0, 0));
		return cmp;
	}

	// ── Header: Agent <icon> <title><status word> (<muted meta>) ──
	// Same split as Agent tool cards: bold family word only; title in toolTitle.
	const isError = d.status !== "completed";
	const icon = d.status === "completed" ? "\u2713" : d.status === "failed" ? "\u2717" : "\u26d4";
	const iconColor = isError ? "error" : "toolTitle";
	const statusWord = isError ? ` ${d.status}` : "";

	const metaParts: string[] = [];
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);
	const metaSuffix = metaParts.length > 0 ? theme.fg("muted", ` (${metaParts.join(" \u00b7 ")})`) : "";

	cmp.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg(iconColor as "toolTitle" | "error", icon)} ${theme.fg("toolTitle", d.title)}${theme.fg(iconColor as "toolTitle" | "error", statusWord)}${metaSuffix}`,
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
		cmp.addChild(new Text(`\n${theme.fg("muted", `session: ${d.sessionPath}`)}`, 0, 0));
	}

	return cmp;
}
