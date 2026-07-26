/**
 * pi-subagent — TUI rendering helpers.
 *
 * `renderCall` and `renderResult` are pure rendering functions:
 * they don't mutate state or call back into the tool.
 *
 * Timer behaviour mirrors pi's built-in bash tool:
 *   - renderCall records startedAt when execution starts
 *   - renderResult shows "Elapsed X.Xs" during execution (isPartial = true)
 *     with 1s refresh interval, then "Took X.Xs" on completion
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { SubagentParams } from "./modes.js";

// ─── Tool details (returned to pi's details: T) ────────────────

export interface SubagentDetails {
	task?: string;
	startedAt?: number;
	endedAt?: number;
}

// ─── Timer state persisted via context.state ───────────────────

interface TimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	model?: string;
	sessionName?: string;
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
// resolved model/session BEFORE the first onUpdate triggers renderCall.

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

/** Build the muted metadata suffix for the header, matching bash's ` (timeout 10s)` pattern.
 *
 * Reads resolved state (written by execute() via getState bridge),
 * falls back to raw args for the collapsed preview before execution starts.
 */
function buildMetaSuffix(state: TimerState, args: SubagentParams, theme: Theme): string {
	const parts: string[] = [];
	const model = state.model ?? args.model;
	if (model) parts.push(model);
	const session = state.sessionName ?? args.session;
	if (session) parts.push(session);
	if (parts.length === 0) return "";
	const joined = parts.join(" | ");
	return theme.fg("muted", ` (${joined})`);
}

// ── Render call (tool header) ──────────────────────────────────

export function renderCall(args: SubagentParams, theme: Theme, context: RenderContext): Text {
	// Save context.state reference so execute() can write resolved
	// model/session before the first onUpdate triggers renderCall.
	if (context.toolCallId) {
		_stateRef.set(context.toolCallId, context.state);
	}

	// Record timer start when execution begins (mirrors bash behaviour)
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}

	const p = args;
	const metaSuffix = buildMetaSuffix(context.state, args, theme);

	if (p.session && p.task) {
		// Battle — header like bash: `$ command` + muted metadata suffix
		const summary = promptSummary(p.task);
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("toolTitle", "\ud83d\udcac")} ${theme.fg("toolTitle", summary)}${metaSuffix}`,
			0,
			0,
		);
	}
	if (p.close) {
		return new Text(theme.fg("toolTitle", theme.bold(`subagent close ${p.session ?? ""}`)), 0, 0);
	}
	// Single task — header like bash: `$ command` + muted metadata suffix
	const emoji = p.interactive ? "\ud83d\udcac" : "\u26a1";
	const summary = promptSummary(p.task);
	return new Text(
		`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("toolTitle", emoji)} ${theme.fg("toolTitle", summary)}${metaSuffix}`,
		0,
		0,
	);
}

// ── Render result (output body) ────────────────────────────────

export function renderResult(
	result: { details?: SubagentDetails; content: { type: string; text?: string }[] },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Container | Text {
	const details = result.details;
	const task = details?.task;

	// Close mode / bare error — just dim text.
	if (!task) {
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		if (!text) return new Text("", 0, 0);
		return new Text(theme.fg("dim", text), 0, 0);
	}

	// ── Timer lifecycle (mirrors bash) ─────────────────────
	const state = context.state;

	// startedAt may come from details (set by onUpdate in execute)
	// or from renderCall (set via context.executionStarted).
	if (details?.startedAt !== undefined && state.startedAt === undefined) {
		state.startedAt = details.startedAt;
	}

	// Start live Elapsed updates on first partial result
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
	}

	// End timer on final result or error
	if (!isPartial || context.isError) {
		state.endedAt ??= details?.endedAt ?? Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}

	// ── Body: full prompt (details.task) + sub‑agent output ──
	const cmp = new Container();

	const promptText = details?.task?.trim();
	const output = result.content[0]?.type === "text" ? (result.content[0].text?.trim() ?? "") : "";

	const hasPrompt = !!promptText;
	const hasOutput = !!output;

	// Build body content (no leading \n — spacing is handled per-mode below)
	const bodyParts: string[] = [];
	if (hasPrompt) {
		bodyParts.push(promptText);
	}
	if (hasPrompt && hasOutput) {
		bodyParts.push(""); // blank line separator
	}
	if (hasOutput) {
		bodyParts.push(output);
	}

	const rawBody = bodyParts.join("\n");
	const bodyContent = rawBody
		?.split("\n")
		.map((l) => theme.fg("toolOutput", l))
		.join("\n");

	if (bodyContent) {
		if (expanded) {
			// bash: \n prefix gives 1 blank line between header and body
			cmp.addChild(new Text(`\n${bodyContent}`, 0, 0));
		} else {
			// bash: always return ["", ...] — first element is the blank line
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

	// ── Footer: Elapsed/Took X.Xs ──
	if (state.startedAt !== undefined) {
		const label = isPartial ? "Elapsed" : "Took";
		const endTime = state.endedAt ?? Date.now();
		cmp.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`)}`, 0, 0));
	}

	return cmp;
}
