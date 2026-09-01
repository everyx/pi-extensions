/**
 * Component preview — 1:1 simulation of a real pi session screen.
 *
 * Each path occupies one full screen and mirrors how pi actually renders:
 * tool calls stack top-down (each call is one slot that evolves in place:
 * pending header → streaming body → completed card), notifications join
 * the stream, and background agents appear in the bottom-fixed widget
 * (registered aboveEditor in pi — visually pinned above the input). Every
 * path loops forever with a blank pause between rounds.
 *
 *   npm run preview              # 1:1 live paths (TTY)
 *   THEME=ayu-dark npm run preview   # or any pi theme name
 */

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { createPreviewRuntime } from "@everyx/pi-ui/preview-runtime.js";
import type { WidgetResult } from "@everyx/pi-ui/widget.js";
import type { AgentProcess } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";
import { renderNotification } from "./render.js";
import type { RenderEvent, SubagentDetails } from "./types.js";
import { sendView, spawnView, stopView } from "./views.js";
import { AgentWidget } from "./widget.js";

/** Minimal Agent params shape for preview stories. */
interface AgentParams {
	prompt: string;
	label: string;
	model?: string;
	thinking?: string;
	run_in_background?: boolean;
}

// ── Views (single source: views.ts — the same templates production registers) ──

const themeName = process.env.THEME || "light";
initTheme(themeName);

// The live theme object lives in an internal module that the package entry
// doesn't re-export and whose subpath is blocked by its "exports" map. Walk
// node_modules physically (tsx's resolver enforces exports even for
// require.resolve) and import the file by absolute URL, which bypasses the
// exports map entirely.
// Dev storybook runtime — shared across extension previews (one implementation).
const { theme, renderLines, toolShell } = await createPreviewRuntime();

/**
 * Simulate pi's framework tool shell (tool-execution.js):
 * for renderShell "default" tools (agent_spawn/agent_stop/agent_send are default), the framework wraps both
 * the call renderer (header) and the result renderer in one Box(1,1) whose
 * background follows state (pending while running, success/error on
 * completion) — covering the header AND the body.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Story data ─────────────────────────────────────────────

const params: AgentParams = {
	prompt: "Check the CI config for flaky tests. Look at the pipeline definition and report issues with evidence.",
	label: "检查 CI 配置",
	model: "claude-sonnet",
	thinking: "high",
};

// Shared timer state — startedAt fixed so elapsed/Took behave like a real
// long-running card (values tick with the wall clock).
/** Simulated task wall-time per round (Elapsed grows to this, then Took shows it). */
const TASK_MS = 27_500;

// Shared render state across frames — the spinner instance rides it so the
// Braille frames keep animating; startedAt is the current round's task
// start (reset on every pause so Elapsed starts fresh each loop).
const cardState: Record<string, unknown> = { startedAt: Date.now() };
function pendingContext(args: unknown, isError = false) {
	return { args, state: cardState, invalidate: () => {}, executionStarted: true, isPartial: true, isError } as never;
}
function doneContext(args: unknown, isError = false) {
	return {
		args,
		state: cardState,
		invalidate: () => {},
		executionStarted: true,
		isPartial: false,
		isError,
	} as never;
}

const activityTool: SubagentDetails["activity"] = { kind: "tool", name: "bash", args: "sleep 20" };
const activityThinking: SubagentDetails["activity"] = { kind: "thinking", text: "" };

function details(extra: Partial<SubagentDetails> = {}): SubagentDetails {
	const st = cardState.startedAt as number;
	return {
		task: params.prompt,
		startedAt: st,
		endedAt: st + TASK_MS,
		model: params.model,
		thinking: params.thinking,
		sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
		...extra,
	};
}

const streamActivities: AgentActivity[] = [
	{ kind: "tool", name: "bash", args: "grep -r retries: .github/workflows" },
	activityThinking,
	{ kind: "tool", name: "bash", args: "git log --oneline -20" },
	{ kind: "tool", name: "bash", args: "npx vitest run --dry orders.test.ts" },
	activityThinking,
	{ kind: "tool", name: "bash", args: "sed -i 's/retries: 0/retries: 2/' vitest.config.ts" },
	activityThinking,
	{ kind: "tool", name: "bash", args: "npx vitest run --repeat 5" },
];
const streamLines = [
	"checking .github/workflows/ci.yml…",
	"found job `test` (node 22, ubuntu-latest)",
	"reading 14 test files…",
	"7 suites, 96 tests, 0 failures",
	"flaky scan: retries: 0 on all 5 specs",
	"digging into git history for the flake…",
	"3 of 5 flaky tests share setup polling gaps",
	"proposed patch: add waitFor with 5s budget",
	"writing patch to vitest.config.ts…",
	"done — patch attached, 5 specs hardened",
];
function activityEvents(count: number): RenderEvent[] {
	return streamActivities.slice(0, count).flatMap((a): RenderEvent[] => {
		if (a.kind === "tool") return [{ kind: "tool", name: a.name, args: a.args }];
		if (a.kind === "thinking") return [{ kind: "thinking" }];
		return [];
	});
}

// ── Screen simulation ─────────────────────────────────────────

/**
 * One slot in the tool-call stream. Like real pi, each call occupies a fixed
 * position that evolves in place (pending → streaming → completed); slots
 * appear top-down as calls are made.
 */
type StreamCard =
	| {
			kind: "agent";
			args: AgentParams;
			details: SubagentDetails;
			isPartial: boolean;
			isError?: boolean;
			expanded?: boolean;
	  }
	| {
			kind: "control";
			args: { agent_id?: string; to?: string; message?: string };
			details: { to?: string; message?: string; label?: string; error?: string; status?: string };
			isPartial: boolean;
			isError?: boolean;
			expanded?: boolean;
	  }
	| {
			kind: "notification";
			details: {
				status: "completed" | "failed" | "stopped";
				agent_id: string;
				label: string;
				model?: string;
				thinking?: string;
				result?: string;
				idle?: boolean;
				usage?: { durationMs?: number; tokens?: number; toolUses?: number };
				sessionPath?: string;
				sessionId?: string;
			};
	  };

interface WidgetAgent {
	id: string;
	/** Present while the agent is running in the widget. */
	label?: string;
	/** Offset (ms) behind the round start — elapsed grows from here. */
	startedOffset?: number;
	activity?: AgentActivity;
	/** Persistent agent completed → idle row (muted, zero-token wait). */
	idle?: boolean;
	/** This phase the agent leaves the widget — `result` feeds the progress meta. */
	removed?: WidgetResult;
}

interface PathPhase {
	name: string;
	ticks: number;
	/** The tool-call stream at this point; null slots don't exist yet. */
	stream?: (StreamCard | null)[];
	/** Dynamic stream (e.g. output growing line by line) — takes precedence. */
	streamFor?: (localTick: number) => (StreamCard | null)[];
	/** Agents pinned in the bottom widget (background tasks). */
	widget?: WidgetAgent[];
	/** Status word in the path title to highlight while this phase is live. */
	status?: string;
}

interface LifecyclePath {
	title: string;
	phases: PathPhase[];
	/** Blank gap between rounds (empty screen). */
	pauseTicks: number;
	/** Screen height (fixed per terminal; set at run time). */
	height: number;
}

function cycleTicks(s: LifecyclePath): number {
	return s.phases.reduce((a, p) => a + p.ticks, 0) + s.pauseTicks;
}

/** Path title with the current phase's status word highlighted (accent). */
function pathTitle(s: LifecyclePath, phase: PathPhase | undefined): string {
	if (!phase?.status) return s.title;
	return s.title.replace(phase.status, theme.fg("accent", phase.status));
}

function renderPathCard(card: StreamCard, w: number): string[] {
	switch (card.kind) {
		case "agent":
			return card.isPartial
				? toolShell(
						"toolPendingBg",
						[
							spawnView.renderCall(card.args as never, theme, pendingContext(card.args)),
							spawnView.renderResult(
								{ content: [], details: card.details } as never,
								{ expanded: false, isPartial: true },
								theme,
								pendingContext(card.args),
							),
						],
						w,
					)
				: toolShell(
						card.isError ? "toolErrorBg" : "toolSuccessBg",
						[
							spawnView.renderCall(card.args as never, theme, doneContext(card.args, card.isError)),
							spawnView.renderResult(
								{ content: [], details: card.details } as never,
								{ expanded: card.expanded ?? false, isPartial: false },
								theme,
								doneContext(card.args, card.isError),
							),
						],
						w,
					);
		case "control": {
			// agent_stop (agent_id) vs agent_send (to) — same shell, different view.
			const isSend = "to" in (card.args as { to?: string });
			return card.isPartial
				? toolShell(
						"toolPendingBg",
						[
							(isSend ? sendView : stopView).renderCall(card.args as never, theme, pendingContext(card.args)),
							(isSend ? sendView : stopView).renderResult(
								{ content: [], details: card.details } as never,
								{ expanded: false, isPartial: true },
								theme,
								pendingContext(card.args),
							),
						],
						w,
					)
				: toolShell(
						card.isError ? "toolErrorBg" : "toolSuccessBg",
						[
							(isSend ? sendView : stopView).renderCall(
								card.args as never,
								theme,
								doneContext(card.args, card.isError),
							),
							(isSend ? sendView : stopView).renderResult(
								{ content: [], details: card.details } as never,
								{ expanded: card.expanded ?? false, isPartial: false },
								theme,
								doneContext(card.args, card.isError),
							),
						],
						w,
					);
		}
		case "notification":
			return renderLines(renderNotification({ details: card.details }, { expanded: false }, theme), w);
	}
}

/**
 * Assemble one screen: the tool-call stream top-aligned, the widget pinned
 * at the bottom (pi registers it aboveEditor — visually the fixed strip
 * above the input), blank padding between them.
 */
function screenLines(stream: (StreamCard | null)[], H: number, w: number): string[] {
	const cardLines: string[] = [];
	for (const card of stream) {
		if (!card) continue;
		// Blank row between stacked cards, like pi's message stream.
		if (cardLines.length) cardLines.push("");
		cardLines.push(...renderPathCard(card, w));
	}
	const widgetLines = widgetRender ? widgetRender() : [];
	const lines = [...cardLines];
	const bottom = Math.max(0, H - widgetLines.length);
	while (lines.length < bottom) lines.push(" ".repeat(w));
	if (widgetLines.length) lines.push(...widgetLines);
	return lines.slice(0, H);
}

// ── Widget (real AgentWidget instance, diffed against each phase) ──

let widgetRender: (() => string[]) | undefined;
const widgetUi = {
	setWidget: (
		_key: string,
		factory: ((tui: unknown, th: Theme) => { render(): string[] }) | undefined,
		_opts: unknown,
	) => {
		widgetRender = factory ? factory({ requestRender: () => {} }, theme).render : undefined;
	},
} as never;
const widget = new AgentWidget(widgetUi as never);
const fakeAgent = (agentId: string, label: string, startedAt: number, activity: unknown) =>
	({
		agentId,
		label,
		startedAt,
		status: "running",
		getLatestActivity: () => activity,
	}) as unknown as AgentProcess;
const widgetState = new Map<string, { startedAt: number }>();
function syncWidget(agents: WidgetAgent[] | undefined): void {
	// 1) Ends first: agents marked `removed` leave the widget with their
	//    result, feeding the lifetime progress meta (`1/3`, `(1+2)/3`).
	for (const a of agents ?? []) {
		if (a.removed && widgetState.delete(a.id)) {
			widget.remove(a.id, a.removed);
		}
	}
	// 2) Then the running set: drop rows that vanished, add new ones.
	const want = new Set((agents ?? []).map((a) => a.id));
	for (const id of widgetState.keys()) {
		if (!want.has(id)) {
			widget.remove(id);
			widgetState.delete(id);
		}
	}
	for (const a of agents ?? []) {
		if (a.removed) continue;
		if (widgetState.has(a.id)) {
			// Status flips for persistent agents (idle ⇄ running on wake/stop).
			widget.setStatus(a.id, a.idle ? "idle" : "running");
			continue;
		}
		if (a.label == null) continue;
		// startedAt per round: elapsed grows from the agent's own start.
		const started = Date.now() - (a.startedOffset ?? 0);
		widgetState.set(a.id, { startedAt: started });
		widget.add(fakeAgent(a.id, a.label, started, a.activity));
		// Persistent agent already completed: register (running) then flip to
		// idle — same two-step path as the real registry (register → markIdle).
		if (a.idle) widget.setStatus(a.id, "idle");
	}
}

// ── Path definitions ─────────────────────────────────────────

const p = params;
const bgArgs: AgentParams = { ...p, run_in_background: true };

// Path A — background: three concurrent agents spawn, work, get messaged,
// stopped, and complete; the widget tracks them at the bottom.
const pathA: LifecyclePath = {
	title: "A · background agents — 3 spawn → working → message → stop → notify (widget pinned at bottom)",
	phases: [
		{
			name: "spawn a1",
			ticks: 20,
			stream: [{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: true }],
			widget: [],
			status: "spawn",
		},
		{
			name: "a1 started",
			ticks: 19,
			stream: [{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false }],
			widget: [{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
			status: "working",
		},
		{
			name: "spawn a2",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: true,
				},
			],
			widget: [{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
			status: "spawn",
		},
		{
			name: "a2 started",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
			],
			status: "working",
		},
		{
			name: "spawn a3",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: true,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
			],
			status: "spawn",
		},
		{
			name: "a3 started",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "kai", label: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
			status: "working",
		},
		{
			name: "working",
			ticks: 40,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "kai", label: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
			status: "working",
		},
		{
			name: "send a2",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { to: "zoe", message: "优先看 orders 表索引" },
					details: { to: "zoe", label: "慢查询排查" },
					isPartial: true,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "kai", label: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
			status: "send",
		},
		{
			name: "sent",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { to: "zoe", message: "优先看 orders 表索引" },
					details: {
						label: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "kai", label: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
			status: "send",
		},
		{
			name: "stop a3",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { to: "zoe", message: "优先看 orders 表索引" },
					details: {
						label: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "kai" },
					details: { label: "审计 reports 表" },
					isPartial: true,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "kai", label: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
			status: "stop",
		},
		{
			name: "stopped a3",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { to: "zoe", message: "优先看 orders 表索引" },
					details: {
						label: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "kai" },
					details: { label: "审计 reports 表" },
					isPartial: false,
				},
			],
			widget: [
				{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "kai", removed: "stopped" },
			],
			status: "stop",
		},
		{
			name: "a1 completes",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { to: "zoe", message: "优先看 orders 表索引" },
					details: {
						label: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "kai" },
					details: { label: "审计 reports 表" },
					isPartial: false,
				},
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "max",
						label: "检查 CI 配置",
						model: p.model,
						thinking: p.thinking,
						result: "Found 5 flaky tests. All share the `retries: 0` flag.",
						usage: { durationMs: 27_500, tokens: 12_500, toolUses: 3 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-1",
					},
				},
			],
			widget: [
				{ id: "zoe", label: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "max", removed: "done" },
			],
			status: "notify",
		},
		{
			name: "a2 completes",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, label: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, label: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, label: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, label: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { to: "zoe", message: "优先看 orders 表索引" },
					details: {
						label: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "kai" },
					details: { label: "审计 reports 表" },
					isPartial: false,
				},
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "max",
						label: "检查 CI 配置",
						model: p.model,
						thinking: p.thinking,
						result: "Found 5 flaky tests. All share the `retries: 0` flag.",
						usage: { durationMs: 27_500, tokens: 12_500, toolUses: 3 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-1",
					},
				},
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "zoe",
						label: "慢查询排查",
						model: p.model,
						thinking: p.thinking,
						result: "Slow query found: orders.idx_created_at missing; added.",
						usage: { durationMs: 42_100, tokens: 18_300, toolUses: 5 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-2",
					},
				},
			],
			widget: [{ id: "zoe", removed: "done" }],
			status: "notify",
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path B — foreground agent: one slot that streams, then completes.
const fgEvents: RenderEvent[] = [
	...activityEvents(streamActivities.length),
	{ kind: "text", text: streamLines.join("\n") },
];
const pathB: LifecyclePath = {
	title: "B · foreground agent — starting → working → done (expanded)",
	phases: [
		{
			name: "starting",
			status: "starting",
			ticks: 20,
			stream: [{ kind: "agent", args: p, details: details(), isPartial: true }],
		},
		{
			name: "working",
			status: "working",
			ticks: 60,
			// Token-stream feel: activity rows appear progressively while the
			// text output types out character by character — like pi's
			// assistant messages streaming in.
			streamFor: (t) => {
				const total = 60;
				const tools = Math.floor((t / total) * (streamActivities.length + 1));
				const textFull = streamLines.join("\n");
				const chars = Math.floor((t / total) * textFull.length);
				const events: RenderEvent[] = [...activityEvents(tools)];
				if (chars > 0) events.push({ kind: "text", text: textFull.slice(0, Math.min(chars, textFull.length)) });
				return [
					{
						kind: "agent",
						args: p,
						details: details({ events }),
						isPartial: true,
					},
				];
			},
		},
		{
			name: "done",
			status: "done",
			ticks: 19,
			stream: [{ kind: "agent", args: p, details: details({ events: fgEvents }), isPartial: false }],
		},
		{
			name: "expanded",
			status: "done",
			ticks: 19,
			stream: [{ kind: "agent", args: p, details: details({ events: fgEvents }), isPartial: false, expanded: true }],
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path C — background failure: spawn dies, failed notification follows.
const pathC: LifecyclePath = {
	title: "C · background failure — starting → start failed → failed notification",
	phases: [
		{
			name: "starting",
			ticks: 20,
			stream: [{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: true }],
		},
		{
			name: "start failed",
			ticks: 19,
			stream: [
				{
					kind: "agent",
					args: bgArgs,
					details: details({
						runInBackground: true,
						label: "bad model",
						error: 'Model "no-such-model-xyz" not available.',
					}),
					isPartial: false,
					isError: true,
				},
			],
			status: "start failed",
		},
		{
			name: "failed notification",
			ticks: 20,
			stream: [
				{
					kind: "agent",
					args: bgArgs,
					details: details({
						runInBackground: true,
						label: "bad model",
						error: 'Model "no-such-model-xyz" not available.',
					}),
					isPartial: false,
					isError: true,
				},
				{
					kind: "notification",
					details: {
						status: "failed",
						agent_id: "max",
						label: params.label,
						model: p.model,
						thinking: p.thinking,
						result: 'Model "no-such-model-xyz" not available.',
						usage: { durationMs: 4_200, tokens: 180, toolUses: 0 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-1",
					},
				},
			],
			status: "failed notification",
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path D — foreground failure: streams a little, then dies mid-run.
const partialEvents: RenderEvent[] = [...activityEvents(2), { kind: "text", text: streamLines.slice(0, 2).join("\n") }];
const pathD: LifecyclePath = {
	title: "D · foreground failure — starting → working → error",
	phases: [
		{
			name: "starting",
			ticks: 20,
			stream: [{ kind: "agent", args: p, details: details(), isPartial: true }],
		},
		{
			name: "working",
			status: "working",
			ticks: 20,
			stream: [{ kind: "agent", args: p, details: details({ events: partialEvents }), isPartial: true }],
		},
		{
			name: "failed",
			ticks: 19,
			stream: [
				{
					kind: "agent",
					args: p,
					details: details({
						events: partialEvents,
						error: "Agent exited with status 1: bash failed after 3 attempts.",
					}),
					isPartial: false,
					isError: true,
				},
			],
			status: "error",
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path E — persistent agent: spawns background, completes to idle (widget row
// stays, notification carries the idle marker), wakes on a message, stopped.
const pathE: LifecyclePath = {
	title: "E · persistent agent — spawn → idle (resident) → message wakes → stopped",
	phases: [
		{
			name: "starting",
			ticks: 20,
			stream: [{ kind: "agent", args: p, details: details({ runInBackground: true }), isPartial: true }],
		},
		{
			name: "started",
			status: "working",
			ticks: 20,
			stream: [
				{ kind: "agent", args: p, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "max",
						label: "检查 CI 配置",
						result: "Found 5 issues, all flaky tests traced to shared setup.",
						usage: { durationMs: 27_500, tokens: 1250, toolUses: 3 },
						idle: true,
					},
				},
			],
			widget: [{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, idle: true }],
		},
		{
			name: "message wakes",
			ticks: 20,
			stream: [
				{ kind: "agent", args: p, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "max",
						label: "检查 CI 配置",
						result: "Found 5 issues, all flaky tests traced to shared setup.",
						usage: { durationMs: 27_500, tokens: 1250, toolUses: 3 },
						idle: true,
					},
				},
				{
					kind: "control",
					args: { to: "max", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					details: { to: "max", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					isPartial: true,
				},
			],
			widget: [{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
		},
		{
			name: "delivered",
			status: "send",
			ticks: 19,
			stream: [
				{ kind: "agent", args: p, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "max",
						label: "检查 CI 配置",
						result: "Found 5 issues, all flaky tests traced to shared setup.",
						usage: { durationMs: 27_500, tokens: 1250, toolUses: 3 },
						idle: true,
					},
				},
				{
					kind: "control",
					args: { to: "max", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					details: { to: "max", label: "检查 CI 配置", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					isPartial: false,
				},
			],
			widget: [{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
		},
		{
			name: "stop",
			ticks: 20,
			stream: [
				{ kind: "agent", args: p, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "control",
					args: { to: "max", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					details: { to: "max", label: "检查 CI 配置", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					isPartial: false,
				},
				{ kind: "control", args: { agent_id: "max" }, details: { label: "检查 CI 配置" }, isPartial: true },
			],
			widget: [{ id: "max", label: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
		},
		{
			name: "stopped",
			status: "stop",
			ticks: 19,
			stream: [
				{ kind: "agent", args: p, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "control",
					args: { to: "max", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					details: { to: "max", label: "检查 CI 配置", message: "继续：给 5 个问题各写一个修复 PR 描述" },
					isPartial: false,
				},
				{ kind: "control", args: { agent_id: "max" }, details: { label: "检查 CI 配置" }, isPartial: false },
			],
		},
	],
	pauseTicks: 30,
	height: 0,
};

const sections: LifecyclePath[] = [pathA, pathB, pathC, pathD, pathE];

// ── Live loop ────────────────────────────────────────────────

function phaseAt(s: LifecyclePath, t: number): { phase: PathPhase; local: number } | null {
	let acc = 0;
	for (const ph of s.phases) {
		if (t < acc + ph.ticks) return { phase: ph, local: t - acc };
		acc += ph.ticks;
	}
	return null; // pause
}

const lastPhase = new Map<LifecyclePath, string>();

function lifecycleRender(s: LifecyclePath, t: number, w: number): string[] {
	const total = cycleTicks(s);
	t %= total;
	const hit = phaseAt(s, t);
	if (!hit) {
		syncWidget([]);
		// Fresh round: the next spawn starts a new Elapsed timer.
		cardState.startedAt = Date.now();
		return blankLines(s.height, w); // blank pause between rounds
	}
	// Phase boundary: drop stale streamed data so a fresh call's header
	// doesn't flash the previous result's tail/meta.
	if (lastPhase.get(s) !== hit.phase.name) {
		lastPhase.set(s, hit.phase.name);
		delete (cardState as Record<string, unknown>).lastData;
	}
	syncWidget(hit.phase.widget);
	const stream = hit.phase.streamFor ? hit.phase.streamFor(hit.local) : (hit.phase.stream ?? []);
	return screenLines(stream, s.height, w);
}

function blankLines(height: number, w: number): string[] {
	return Array.from({ length: height }, () => " ".repeat(w));
}

async function runLive(): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("preview needs a TTY — run it in a terminal (tmux, kitty, …).");
		process.exit(1);
	}
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write("\x1b[?25l"); // hide cursor
	const rows = process.stdout.rows ?? 40;
	const width = process.stdout.columns ?? 100;
	// One screen per path: full-height canvas, key-paginated.
	const height = rows - 2; // path title row + bottom page indicator
	for (const s of sections) s.height = height;
	let page = 0;
	let quit = false;
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (chunk: Buffer) => {
			const s = chunk.toString();
			if (s === "\u0003") {
				quit = true;
			} else if (s === " " || s === "n" || s === "\r" || s === "\x1b[C") {
				page = (page + 1) % sections.length;
			} else if (s === "p" || s === "\x1b[D") {
				page = (page - 1 + sections.length) % sections.length;
			}
		});
	}
	try {
		for (let t = 0; !quit; t++) {
			// The path title highlights the live status word.
			const total = cycleTicks(sections[page]);
			const hit = phaseAt(sections[page], t % total);
			process.stdout.write(`\x1b[1;1H\x1b[2K\x1b[1m\x1b[4m${pathTitle(sections[page], hit?.phase)}\x1b[0m`);
			const lines = lifecycleRender(sections[page], t, width);
			for (let k = 0; k < height; k++) {
				process.stdout.write(`\x1b[${2 + k};1H\x1b[2K${lines[k] ?? " "}`);
			}
			process.stdout.write(
				`\x1b[${rows};1H\x1b[2K\x1b[2m— path ${page + 1}/${sections.length} (→/space next · ←/p prev · Ctrl+C quit) —\x1b[0m`,
			);
			await sleep(80);
		}
	} finally {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}
		process.stdout.write("\x1b[?25h\n");
		process.exit(0);
	}
}

await runLive();
widget.dispose();
