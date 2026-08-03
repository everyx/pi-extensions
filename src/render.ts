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

// ─── Tool params ───────────────────────────────────────────

export interface AgentParams {
	prompt: string;
	/** Optional 3-5 word task title — primary header/notification title, prompt first line as fallback. */
	title?: string;
	model?: string;
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

// ─── Bridging execute() → context.state ───────────────────────
//
// pi doesn't expose context.state to execute(), but renderCall does
// have access.  We save the reference here so execute can write
// resolved model BEFORE the first onUpdate triggers renderCall.

const _stateRef = new Map<string, TimerState>();

export function getState(toolCallId: string): TimerState | undefined {
	return _stateRef.get(toolCallId);
}

export function releaseState(toolCallId: string): void {
	_stateRef.delete(toolCallId);
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Extract a one‑line prompt summary: the first line, with an ellipsis if truncated. */
function promptSummary(s?: string): string {
	if (!s) return "";
	const idx = s.indexOf("\n");
	if (idx < 0) return s;
	return `${s.slice(0, idx)}\u2026`;
}

/** Muted metadata suffix, mirroring bash's ` (timeout 10s)` pattern. */
function buildMetaSuffix(state: TimerState, args: AgentParams, theme: Theme): string {
	const parts: string[] = [];
	if (args.run_in_background) parts.push("background");
	const model = state.model ?? args.model;
	if (model) parts.push(model);
	if (parts.length === 0) return "";
	return theme.fg("muted", ` (${parts.join(" | ")})`);
}

// ── Render call (tool header) ──────────────────────────────────

export function renderAgentCall(args: AgentParams, theme: Theme, context: RenderContext): Text {
	if (context.toolCallId) {
		_stateRef.set(context.toolCallId, context.state);
	}
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}

	const summary = args.title?.trim() || promptSummary(args.prompt);
	const emoji = args.run_in_background ? "\ud83c\udfaf" : "\u26a1";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("agent"))} ${theme.fg("toolTitle", emoji)} ${theme.fg("toolTitle", summary)}${buildMetaSuffix(context.state, args, theme)}`,
		0,
		0,
	);
}

export function renderAgentControlCall(args: AgentControlParams, theme: Theme): Text {
	const verb = args.action === "steer" ? "\ud83e\udde9 steer" : "\u26d4 stop";
	return new Text(theme.fg("toolTitle", theme.bold(`agent control ${verb} ${args.agent_id}`)), 0, 0);
}

// ── Render result (output body) ────────────────────────────────

export function renderAgentResult(
	result: { details?: SubagentDetails; content: { type: string; text?: string }[] },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Container | Text {
	const details = result.details;

	// Background start / control ack — dim one-liner.
	if (details?.agentId && !details.task) {
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		if (!text) return new Text("", 0, 0);
		return new Text(theme.fg("dim", text), 0, 0);
	}

	// Bare error — dim text.
	if (!details?.task) {
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		if (!text) return new Text("", 0, 0);
		return new Text(theme.fg("dim", text), 0, 0);
	}

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
	const output = result.content[0]?.type === "text" ? (result.content[0].text?.trim() ?? "") : "";

	const bodyParts: string[] = [];
	if (promptText) bodyParts.push(promptText);
	if (promptText && output) bodyParts.push("");
	if (output) bodyParts.push(output);
	const rawBody = bodyParts.join("\n");
	const bodyContent = rawBody
		?.split("\n")
		.map((l) => theme.fg("toolOutput", l))
		.join("\n");

	if (bodyContent) {
		if (expanded) {
			cmp.addChild(new Text(`\n${bodyContent}`, 0, 0));
		} else {
			cmp.addChild({
				invalidate: () => {},
				render: (w: number) => {
					const preview = truncateToVisualLines(bodyContent, 5, w, 0);
					if (preview.skippedCount === 0) return ["", ...preview.visualLines];
					const hint = `${theme.fg("muted", `... ${preview.skippedCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
					return ["", hint, ...preview.visualLines];
				},
			});
		}
	}

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

export function renderAgentControlResult(
	result: { details?: Record<string, unknown>; content: { type: string; text?: string }[] },
	_opts: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text {
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	if (!text) return new Text("", 0, 0);
	return new Text(theme.fg("dim", text), 0, 0);
}

// ── Notification card (registerMessageRenderer) ────────────────

export interface NotificationDetails {
	status: string;
	agent_id: string;
	title?: string;
	usage?: {
		tokens?: number | null;
		toolUses?: number | null;
		durationMs?: number | null;
	};
	sessionPath?: string;
	sessionId?: string;
}

export function renderNotification(
	message: { details?: NotificationDetails },
	_opts: unknown,
	theme: Theme,
): Container {
	const d = message.details;
	const cmp = new Container();

	if (!d) {
		cmp.addChild(new Text(theme.fg("dim", "sub-agent notification (no details)"), 0, 0));
		return cmp;
	}

	const statusColor = d.status === "completed" ? "toolTitle" : "error";
	const badge = d.status === "completed" ? "\u2705" : d.status === "failed" ? "\u274c" : "\u26d4";
	const title = d.title ?? `sub-agent ${d.agent_id}`;
	cmp.addChild(
		new Text(
			`${theme.fg(statusColor as "toolTitle" | "error", theme.bold(`${badge} ${title}`))} ${theme.fg("muted", `(${d.status})`)}`,
			0,
			0,
		),
	);

	const usageParts: string[] = [];
	if (d.usage?.durationMs != null) usageParts.push(`${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) usageParts.push(`${d.usage.tokens} tokens`);
	if (d.usage?.toolUses != null) usageParts.push(`${d.usage.toolUses} tool uses`);
	if (usageParts.length > 0) {
		cmp.addChild(new Text(theme.fg("muted", usageParts.join(" \u00b7 ")), 0, 0));
	}

	if (d.sessionPath) {
		// Full path — `pi --session <path>` is the only way to attach (custom dir).
		cmp.addChild(new Text(theme.fg("muted", `session: ${d.sessionPath}`), 0, 0));
	}

	return cmp;
}
