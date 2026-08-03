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
	model?: string;
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
export function splitToolLabel(text: string): { name: string; args: string } | null {
	const colon = text.indexOf(": ");
	if (colon <= 0) return null;
	return { name: text.slice(0, colon), args: text.slice(colon + 2) };
}

/** Extract a one-line summary of a long string: first line, ellipsis if truncated. */
function firstLine(s: string): string {
	const idx = s.indexOf("\n");
	return idx < 0 ? s : `${s.slice(0, idx)}\u2026`;
}

/** Muted metadata suffix, mirroring bash's ` (timeout 10s)` pattern. */
function buildMetaSuffix(state: TimerState, args: AgentParams, theme: Theme): string {
	const parts: string[] = [];
	if (args.run_in_background) parts.push("background");
	const model = state.model ?? args.model;
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
		`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("toolTitle", title)}${buildMetaSuffix(context.state, args, theme)}`,
		0,
		0,
	);
}

export function renderAgentControlCall(args: AgentControlParams, theme: Theme): Text {
	const verb = args.action === "steer" ? "steer" : "stop";
	return new Text(theme.fg("toolTitle", theme.bold(`Agent ${verb} ${args.agent_id}`)), 0, 0);
}

// ── Render result (output body) ────────────────────────────────

/** Dim one-liner for background-start/control acks and bare errors. */
function dimOneLiner(text: string | undefined, theme: Theme): Text {
	if (!text) return new Text("", 0, 0);
	return new Text(theme.fg("dim", text), 0, 0);
}

/**
 * Shared output body: colored toolOutput lines, collapsed to 5 lines with
 * an expand hint (bash-style), or full when expanded. Returns null when
 * there is nothing to show.
 */
type BodyComponent = Text | { invalidate: () => void; render: (w: number) => string[] };

function renderBody(bodyParts: string[], expanded: boolean, theme: Theme): BodyComponent | null {
	const rawBody = bodyParts.filter((p) => p).join("\n");
	if (!rawBody) return null;
	const bodyContent = rawBody
		.split("\n")
		.map((l) => theme.fg("toolOutput", l))
		.join("\n");
	if (expanded) return new Text(`\n${bodyContent}`, 0, 0);
	return {
		invalidate: () => {},
		render: (w: number) => {
			const preview = truncateToVisualLines(bodyContent, 5, w, 0);
			if (preview.skippedCount === 0) return ["", ...preview.visualLines];
			const hint = `${theme.fg("muted", `... ${preview.skippedCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
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
		if (activity.kind === "thinking") {
			// Same label/style as pi's hidden thinking and the Agents widget.
			cmp.addChild(new Text(`\n${theme.italic(theme.fg("thinkingText", "Thinking..."))}`, 0, 0));
		} else if (activity.kind === "tool") {
			const tool = splitToolLabel(activity.text);
			if (tool) {
				cmp.addChild(new Text(`\n${theme.fg("toolTitle", tool.name)}: ${theme.fg("muted", tool.args)}`, 0, 0));
			} else {
				cmp.addChild(new Text(`\n${theme.fg("toolTitle", activity.text)}`, 0, 0));
			}
		}
	}

	// Body: prompt (input) + blank line + final output.
	const bodyParts: string[] = [];
	if (promptText) bodyParts.push(promptText);
	if (promptText && output) bodyParts.push("");
	if (output) bodyParts.push(output);
	const body = renderBody(bodyParts, expanded, theme);
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
 * Steer renders as a relay of the Agent card — same input/output body
 * structure (message → agent snapshot), confirmation as muted footer.
 * Stop stays a dim one-liner (no output to show).
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

		// Body: steer message (input) + blank line + agent output snapshot.
		const bodyParts: string[] = [];
		if (d.message.trim()) bodyParts.push(d.message.trim());
		if (d.snapshot?.trim()) {
			bodyParts.push("");
			bodyParts.push(d.snapshot.trim());
		}
		const body = renderBody(bodyParts, expanded, theme);
		if (body) cmp.addChild(body);

		// Footer: confirmation, muted.
		if (text) {
			cmp.addChild(new Text(`\n${theme.fg("muted", text)}`, 0, 0));
		}
		return cmp;
	}

	// stop / errors — dim one-liner.
	return dimOneLiner(text, theme);
}

// ── Notification card (registerMessageRenderer) ────────────────

export interface NotificationDetails {
	status: string;
	agent_id: string;
	title?: string;
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

/** How many lines of the result the expanded card shows (rest: session file). */
const NOTIFICATION_EXPANDED_LINES = 30;

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
		cmp.addChild(new Text(theme.fg("dim", "sub-agent notification (no details)"), 0, 0));
		return cmp;
	}

	// ── Header: Agent <icon> <title><status word> (<muted meta>) ──
	const isError = d.status !== "completed";
	const icon = d.status === "completed" ? "\u2713" : d.status === "failed" ? "\u2717" : "\u26d4";
	const iconColor = isError ? "error" : "toolTitle";
	const statusWord = isError ? ` ${d.status}` : "";

	const metaParts: string[] = [];
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);
	const metaSuffix = metaParts.length > 0 ? theme.fg("muted", ` (${metaParts.join(" \u00b7 ")})`) : "";

	const title = d.title ?? `sub-agent ${d.agent_id}`;
	cmp.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg(iconColor as "toolTitle" | "error", icon)} ${theme.bold(title)}${statusWord}${metaSuffix}`,
			0,
			0,
		),
	);

	// ── Body: result preview (collapsed: first line; expanded: up to 30 lines) ──
	const result = d.result?.trim();
	if (result) {
		const lines = result.split("\n");
		const shown = expanded ? lines.slice(0, NOTIFICATION_EXPANDED_LINES) : lines.slice(0, 1);
		const body = shown.map((l) => theme.fg("toolOutput", l)).join("\n");
		cmp.addChild(new Text(`\n${body}`, 0, 0));
		if (expanded && lines.length > NOTIFICATION_EXPANDED_LINES) {
			cmp.addChild(
				new Text(
					theme.fg("muted", `\n... ${lines.length - NOTIFICATION_EXPANDED_LINES} more lines in session file`),
					0,
					0,
				),
			);
		}
	}

	// ── Footer: session path (resume entry, custom dir → path required) ──
	if (d.sessionPath) {
		cmp.addChild(new Text(`\n${theme.fg("muted", `session: ${d.sessionPath}`)}`, 0, 0));
	}

	return cmp;
}
