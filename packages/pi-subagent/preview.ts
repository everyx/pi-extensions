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

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { createToolView } from "@everyx/pi-ui/view.js";
import type { AgentProcess } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";
import { renderNotification } from "./render.js";
import { AgentWidget } from "./widget.js";

/** Minimal Agent params shape for preview stories. */
interface AgentParams {
	prompt: string;
	title: string;
	model?: string;
	thinking?: string;
	run_in_background?: boolean;
}

interface RenderEvent {
	kind: "thinking" | "tool" | "text";
	name?: string;
	args?: string;
	text?: string;
}

interface SubagentDetails {
	task?: string;
	title?: string;
	model?: string;
	thinking?: string;
	runInBackground?: boolean;
	error?: string;
	sessionPath?: string;
	startedAt?: number;
	endedAt?: number;
	activity?: AgentActivity;
	events?: RenderEvent[];
	status?: string;
	result?: string;
	usage?: { durationMs?: number; tokens?: number; toolUses?: number };
}

// ── Views (same templates as index.ts) ─────────────────────────

const agentView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "Agent",
	title: (ctx) => {
		const d = ctx.result?.data as { title?: string; task?: string } | undefined;
		return String((ctx.args as { title?: unknown } | undefined)?.title ?? d?.title ?? d?.task ?? "").slice(0, 60);
	},
	tail: (ctx) => (ctx.status === "error" ? "start failed" : ctx.status === "processing" ? "starting\u2026" : "started"),
	meta: (ctx) => {
		const d = ctx.result?.data as
			| { model?: string; thinking?: string; startedAt?: number; endedAt?: number }
			| undefined;
		const parts: string[] = [];
		if (d?.model) parts.push(d.model);
		if (d?.thinking) parts.push(d.thinking);
		if (d?.startedAt != null) parts.push(`Took ${((d.endedAt ?? Date.now()) - d.startedAt) / 1000}s`);
		return parts;
	},
	body: {
		rows: {
			of: (ctx) => ((ctx.result?.data as { events?: unknown[] } | undefined)?.events ?? []) as unknown[],
			rows: [
				{
					content: (_ctx, ev) => {
						const e = ev as { kind: string; name?: string; args?: string; text?: string };
						if (e.kind === "thinking") return { style: "thinking", content: "Thinking..." };
						if (e.kind === "tool") return { style: "tool", content: `${e.name ?? ""}: ${e.args ?? ""}` };
						return { style: "text", content: e.text ?? "" };
					},
				},
			],
		},
	},
});

const agentControlView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "AgentControl",
	title: (ctx) =>
		String(
			(ctx.args as { agent_id?: unknown } | undefined)?.agent_id ??
				(ctx.result?.data as { title?: string } | undefined)?.title ??
				"",
		).slice(0, 60),
	tail: (ctx) => {
		const action = String(
			(ctx.args as { action?: unknown } | undefined)?.action ??
				(ctx.result?.data as { action?: string } | undefined)?.action ??
				"",
		);
		const verb = action === "steer" ? "steer" : action === "stop" ? "stop" : "control";
		if (ctx.status === "error") return `${verb} failed`;
		if (ctx.status === "processing") return verb === "stop" ? "stopping\u2026" : `${verb}ing\u2026`;
		if (ctx.status === "stop") return "stopped";
		return verb === "stop" ? "stopped" : verb === "steer" ? "steered" : "controlled";
	},
	body: { text: (ctx) => (ctx.result?.data as { message?: string } | undefined)?.message ?? "" },
});

const themeName = process.env.THEME || "light";
initTheme(themeName);

// The live theme object lives in an internal module that the package entry
// doesn't re-export and whose subpath is blocked by its "exports" map. Walk
// node_modules physically (tsx's resolver enforces exports even for
// require.resolve) and import the file by absolute URL, which bypasses the
// exports map entirely.
function findPkgDir(name: string): string | null {
	let dir = import.meta.dirname;
	for (;;) {
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
const pkgDir = findPkgDir("@earendil-works/pi-coding-agent");
if (!pkgDir) throw new Error("pi-coding-agent not found under node_modules");
const themeModulePath = path.join(pkgDir, "dist", "modes", "interactive", "theme", "theme.js");
const { theme: globalTheme } = (await import(pathToFileURL(themeModulePath).href)) as { theme: Theme };
const theme = globalTheme as Theme;

function renderLines(component: unknown, width = 100): string[] {
	const c = component as { render(w: number): string[] };
	return c.render(width);
}

/**
 * Simulate pi's framework tool shell (tool-execution.js): for renderShell
 * "default" tools (Agent/AgentControl are default), the framework wraps both
 * the call renderer (header) and the result renderer in one Box(1,1) whose
 * background follows state (pending while running, success/error on
 * completion) — covering the header AND the body.
 */
function shell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[]) {
	const box = new Box(1, 1, (t: string) => theme.bg(bg, t));
	for (const child of children) box.addChild(child as never);
	return { render: (w: number) => renderLines(box, w) };
}

function toolShell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[], w = 100): string[] {
	return renderLines(shell(bg, children), w);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Story data ─────────────────────────────────────────────

const params: AgentParams = {
	prompt: "Check the CI config for flaky tests. Look at the pipeline definition and report issues with evidence.",
	title: "检查 CI 配置",
	model: "claude-sonnet",
	thinking: "high",
};

// Shared timer state — startedAt fixed so elapsed/Took behave like a real
// long-running card (values tick with the wall clock).
const startedAt = Date.now() - 27_500;
const endedAt = Date.now() - 1_200;

function pendingContext(args: unknown, isError = false) {
	return {
		args,
		state: { startedAt },
		invalidate: () => {},
		executionStarted: true,
		isPartial: true,
		isError,
	} as never;
}
function doneContext(args: unknown, isError = false) {
	return {
		args,
		state: { startedAt, endedAt },
		invalidate: () => {},
		executionStarted: true,
		isPartial: false,
		isError,
	} as never;
}

const activityTool: SubagentDetails["activity"] = { kind: "tool", name: "bash", args: "sleep 20" };
const activityThinking: SubagentDetails["activity"] = { kind: "thinking", text: "" };

function details(extra: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		task: params.prompt,
		startedAt,
		endedAt,
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
			args: { agent_id: string; action: string; message?: string };
			details: { action: string; title?: string; message?: string; error?: string; status?: string };
			isPartial: boolean;
			isError?: boolean;
			expanded?: boolean;
	  }
	| {
			kind: "notification";
			details: {
				status: "completed" | "failed" | "stopped";
				agent_id: string;
				title: string;
				model?: string;
				thinking?: string;
				result?: string;
				usage?: { durationMs?: number; tokens?: number; toolUses?: number };
				sessionPath?: string;
				sessionId?: string;
			};
	  };

interface WidgetAgent {
	id: string;
	title: string;
	/** Offset (ms) behind the round start — elapsed grows from here. */
	startedOffset: number;
	activity: AgentActivity;
}

interface PathPhase {
	name: string;
	ticks: number;
	/** The tool-call stream at this point; null slots don't exist yet. */
	stream: (StreamCard | null)[];
	/** Agents pinned in the bottom widget (background tasks). */
	widget?: WidgetAgent[];
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

function renderPathCard(card: StreamCard, w: number): string[] {
	switch (card.kind) {
		case "agent":
			return card.isPartial
				? toolShell(
						"toolPendingBg",
						[
							agentView.renderCall(card.args as never, theme, pendingContext(card.args)),
							agentView.renderResult(
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
							agentView.renderCall(card.args as never, theme, doneContext(card.args, card.isError)),
							agentView.renderResult(
								{ content: [], details: card.details } as never,
								{ expanded: card.expanded ?? false, isPartial: false },
								theme,
								doneContext(card.args, card.isError),
							),
						],
						w,
					);
		case "control":
			return card.isPartial
				? toolShell(
						"toolPendingBg",
						[
							agentControlView.renderCall(card.args as never, theme, pendingContext(card.args)),
							agentControlView.renderResult(
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
							agentControlView.renderCall(card.args as never, theme, doneContext(card.args, card.isError)),
							agentControlView.renderResult(
								{ content: [], details: card.details } as never,
								{ expanded: card.expanded ?? false, isPartial: false },
								theme,
								doneContext(card.args, card.isError),
							),
						],
						w,
					);
		case "notification":
			return renderLines(renderNotification({ details: card.details }, { expanded: false }, theme), w);
	}
}

/**
 * Assemble one screen: the tool-call stream top-aligned, the widget pinned
 * at the bottom (pi registers it aboveEditor — visually the fixed strip
 * above the input), blank padding between them.
 */
function screenLines(stream: (StreamCard | null)[], phaseTicks: number, H: number, w: number): string[] {
	const cardLines: string[] = [];
	for (const card of stream) {
		if (!card) continue;
		// Streaming agent cards get the elapsed time baked into their stream
		// phase (see path B); others are static.
		cardLines.push(...renderPathCard(card, w));
	}
	void phaseTicks;
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
const fakeAgent = (agentId: string, title: string, startedAt: number, activity: unknown) =>
	({
		agentId,
		title,
		startedAt,
		status: "running",
		getLatestActivity: () => activity,
	}) as unknown as AgentProcess;
const widgetState = new Map<string, { startedAt: number }>();
function syncWidget(agents: WidgetAgent[] | undefined): void {
	const want = new Set((agents ?? []).map((a) => a.id));
	for (const id of widgetState.keys()) {
		if (!want.has(id)) {
			widget.remove(id);
			widgetState.delete(id);
		}
	}
	for (const a of agents ?? []) {
		if (!widgetState.has(a.id)) {
			// startedAt per round: elapsed grows from the agent's own start.
			const started = Date.now() - a.startedOffset;
			widgetState.set(a.id, { startedAt: started });
			widget.add(fakeAgent(a.id, a.title, started, a.activity));
		}
	}
}

// ── Path definitions ─────────────────────────────────────────

const p = params;
const bgArgs: AgentParams = { ...p, run_in_background: true };

// Path A — background: three concurrent agents spawn, work, get steered,
// stopped, and complete; the widget tracks them at the bottom.
const pathA: LifecyclePath = {
	title: "A · background agents — 3 spawn → work → steer → stop → notify (widget pinned at bottom)",
	phases: [
		{
			name: "spawn a1",
			ticks: 20,
			stream: [{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: true }],
			widget: [],
		},
		{
			name: "a1 started",
			ticks: 19,
			stream: [{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false }],
			widget: [{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
		},
		{
			name: "spawn a2",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: true,
				},
			],
			widget: [{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool }],
		},
		{
			name: "a2 started",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
			],
		},
		{
			name: "spawn a3",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: true,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
			],
		},
		{
			name: "a3 started",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "a3", title: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
		},
		{
			name: "working",
			ticks: 40,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "a3", title: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
		},
		{
			name: "steer a2",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a2", action: "steer", message: "优先看 orders 表索引" },
					details: { action: "steer", title: "慢查询排查" },
					isPartial: true,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "a3", title: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
		},
		{
			name: "steered",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a2", action: "steer", message: "优先看 orders 表索引" },
					details: {
						action: "steer",
						title: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "a3", title: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
		},
		{
			name: "stop a3",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a2", action: "steer", message: "优先看 orders 表索引" },
					details: {
						action: "steer",
						title: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a3", action: "stop" },
					details: { action: "stop", title: "审计 reports 表" },
					isPartial: true,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
				{ id: "a3", title: "审计 reports 表", startedOffset: 3_000, activity: activityTool },
			],
		},
		{
			name: "stopped a3",
			ticks: 19,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a2", action: "steer", message: "优先看 orders 表索引" },
					details: {
						action: "steer",
						title: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a3", action: "stop" },
					details: { action: "stop", title: "审计 reports 表", status: "stop" },
					isPartial: false,
				},
			],
			widget: [
				{ id: "a1", title: "检查 CI 配置", startedOffset: 27_500, activity: activityTool },
				{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking },
			],
		},
		{
			name: "a1 completes",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a2", action: "steer", message: "优先看 orders 表索引" },
					details: {
						action: "steer",
						title: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a3", action: "stop" },
					details: { action: "stop", title: "审计 reports 表", status: "stop" },
					isPartial: false,
				},
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "a1",
						title: "检查 CI 配置",
						model: p.model,
						thinking: p.thinking,
						result: "Found 5 flaky tests. All share the `retries: 0` flag.",
						usage: { durationMs: 27_500, tokens: 12_500, toolUses: 3 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-1",
					},
				},
			],
			widget: [{ id: "a2", title: "慢查询排查", startedOffset: 12_000, activity: activityThinking }],
		},
		{
			name: "a2 completes",
			ticks: 20,
			stream: [
				{ kind: "agent", args: bgArgs, details: details({ runInBackground: true }), isPartial: false },
				{
					kind: "agent",
					args: { ...bgArgs, title: "慢查询排查", prompt: "Find slow queries on the orders table." },
					details: details({ runInBackground: true, title: "慢查询排查" }),
					isPartial: false,
				},
				{
					kind: "agent",
					args: { ...bgArgs, title: "审计 reports 表", prompt: "Audit the reports table for stale aggregates." },
					details: details({ runInBackground: true, title: "审计 reports 表" }),
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a2", action: "steer", message: "优先看 orders 表索引" },
					details: {
						action: "steer",
						title: "慢查询排查",
						message: "优先看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					isPartial: false,
				},
				{
					kind: "control",
					args: { agent_id: "a3", action: "stop" },
					details: { action: "stop", title: "审计 reports 表", status: "stop" },
					isPartial: false,
				},
				{
					kind: "notification",
					details: {
						status: "completed",
						agent_id: "a1",
						title: "检查 CI 配置",
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
						agent_id: "a2",
						title: "慢查询排查",
						model: p.model,
						thinking: p.thinking,
						result: "Slow query found: orders.idx_created_at missing; added.",
						usage: { durationMs: 42_100, tokens: 18_300, toolUses: 5 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-2",
					},
				},
			],
			widget: [],
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
	title: "B · foreground agent — starting → stream → collapsed → expanded",
	phases: [
		{
			name: "starting",
			ticks: 20,
			stream: [{ kind: "agent", args: p, details: details(), isPartial: true }],
		},
		{
			name: "streaming",
			ticks: 60,
			stream: [
				{
					kind: "agent",
					args: p,
					details: details({ events: [] }),
					isPartial: true,
				},
			],
		},
		{
			name: "collapsed",
			ticks: 19,
			stream: [{ kind: "agent", args: p, details: details({ events: fgEvents }), isPartial: false }],
		},
		{
			name: "expanded",
			ticks: 19,
			stream: [{ kind: "agent", args: p, details: details({ events: fgEvents }), isPartial: false, expanded: true }],
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path C — background failure: spawn dies, failed notification follows.
const pathC: LifecyclePath = {
	title: "C · background failure — start failed → failed notification",
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
						title: "bad model",
						error: 'Model "no-such-model-xyz" not available.',
					}),
					isPartial: false,
					isError: true,
				},
			],
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
						title: "bad model",
						error: 'Model "no-such-model-xyz" not available.',
					}),
					isPartial: false,
					isError: true,
				},
				{
					kind: "notification",
					details: {
						status: "failed",
						agent_id: "a1",
						title: params.title,
						model: p.model,
						thinking: p.thinking,
						result: 'Model "no-such-model-xyz" not available.',
						usage: { durationMs: 4_200, tokens: 180, toolUses: 0 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-1",
					},
				},
			],
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path D — foreground failure: streams a little, then dies mid-run.
const partialEvents: RenderEvent[] = [...activityEvents(2), { kind: "text", text: streamLines.slice(0, 2).join("\n") }];
const pathD: LifecyclePath = {
	title: "D · foreground failure — starting → partial stream → error",
	phases: [
		{
			name: "starting",
			ticks: 20,
			stream: [{ kind: "agent", args: p, details: details(), isPartial: true }],
		},
		{
			name: "partial stream",
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
		},
	],
	pauseTicks: 30,
	height: 0,
};

const sections: LifecyclePath[] = [pathA, pathB, pathC, pathD];

// ── Live loop ────────────────────────────────────────────────

function phaseAt(s: LifecyclePath, t: number): { phase: PathPhase; local: number } | null {
	let acc = 0;
	for (const ph of s.phases) {
		if (t < acc + ph.ticks) return { phase: ph, local: t - acc };
		acc += ph.ticks;
	}
	return null; // pause
}

function lifecycleRender(s: LifecyclePath, t: number, w: number): string[] {
	const total = cycleTicks(s);
	t %= total;
	const hit = phaseAt(s, t);
	if (!hit) {
		syncWidget([]);
		return blankLines(s.height, w); // blank pause between rounds
	}
	syncWidget(hit.phase.widget);
	return screenLines(hit.phase.stream, hit.local, s.height, w);
}

function blankLines(height: number, w: number): string[] {
	return Array.from({ length: height }, () => " ".repeat(w));
}

async function runLive(): Promise<void> {
	console.log(
		"\n\x1b[1m\x1b[4mLive — each path is one full screen, looping with a blank pause between rounds (Ctrl+C to exit)\x1b[0m",
	);
	if (!process.stdout.isTTY) {
		console.error("preview needs a TTY — run it in a terminal (tmux, kitty, …).");
		process.exit(1);
	}
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write(
		"\x1b[1m\x1b[4mLive — each path is one full screen, looping with a blank pause between rounds (Ctrl+C to exit)\x1b[0m\n",
	);
	process.stdout.write("\x1b[?25l"); // hide cursor
	const rows = process.stdout.rows ?? 40;
	const width = process.stdout.columns ?? 100;
	// One screen per path: full-height canvas, key-paginated.
	const height = rows - 4; // top title + bottom page indicator + margins
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
			process.stdout.write(`\x1b[2;1H\x1b[2K\x1b[1m\x1b[4m${sections[page].title}\x1b[0m`);
			const lines = lifecycleRender(sections[page], t, width);
			for (let k = 0; k < height; k++) {
				process.stdout.write(`\x1b[${3 + k};1H\x1b[2K${lines[k] ?? " "}`);
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
