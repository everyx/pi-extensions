/**
 * Component preview — a mini "storybook" for the extension's TUI renderers.
 *
 * Renders the typical sub-agent lifecycles end to end through the real
 * render pipeline with the real pi theme: each section replays one complete
 * lifecycle (background agent, foreground agent, background failure,
 * foreground failure), loops it forever with a blank pause between rounds,
 * and everything that moves animates in place.
 *
 *   npm run preview              # live lifecycles (TTY)
 *   npm run preview -- static    # sampled frames only
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

/** Render one tool card inside the framework shell (default shell behavior). */
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

// Shared timer state — the startedAt is fixed so elapsed/Took behave like a
// real long-running card (values tick with the wall clock).
const startedAt = Date.now() - 27_500;

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
const endedAt = Date.now() - 1_200;
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

// ── Lifecycle scaffolding ────────────────────────────────────

interface Phase {
	name: string;
	ticks: number;
	/** Render this phase at local tick t (0..ticks-1) for width w. */
	render: (t: number, w: number) => string[];
}

interface LifecycleSection {
	title: string;
	phases: Phase[];
	/** Blank gap between rounds (empty canvas keeps pagination stable). */
	pauseTicks: number;
	/** Fixed canvas height (max phase height, measured at setup). */
	height: number;
}

function cycleTicks(s: LifecycleSection): number {
	return s.phases.reduce((a, p) => a + p.ticks, 0) + s.pauseTicks;
}

function blankLines(height: number, w: number): string[] {
	return Array.from({ length: height }, () => " ".repeat(w));
}

function lifecycleRender(s: LifecycleSection, t: number, w: number): string[] {
	t %= cycleTicks(s);
	let acc = 0;
	for (const p of s.phases) {
		if (t < acc + p.ticks) return p.render(t - acc, w);
		acc += p.ticks;
	}
	return blankLines(s.height, w); // pause: blank separator between rounds
}

// Render helpers: pending = call header + bare streaming body; done = full
// card (call renders an empty line once complete).
function pendingCard(
	view: ReturnType<typeof createToolView<Record<string, unknown>, Record<string, unknown>>>,
	args: unknown,
	result: unknown,
	w: number,
) {
	return toolShell(
		"toolPendingBg",
		[
			view.renderCall(args as never, theme, pendingContext(args)),
			view.renderResult(
				{ content: [], details: result } as never,
				{ expanded: false, isPartial: true },
				theme,
				pendingContext(args),
			),
		],
		w,
	);
}

function doneCard(
	view: ReturnType<typeof createToolView<Record<string, unknown>, Record<string, unknown>>>,
	args: unknown,
	result: unknown,
	w: number,
	opts: { isError?: boolean; expanded?: boolean } = {},
) {
	const ctx = doneContext(args, opts.isError ?? false);
	return toolShell(
		opts.isError ? "toolErrorBg" : "toolSuccessBg",
		[
			view.renderCall(args as never, theme, ctx),
			view.renderResult(
				{ content: [], details: result } as never,
				{ expanded: opts.expanded ?? false, isPartial: false },
				theme,
				ctx,
			),
		],
		w,
	);
}

// ── Path A: background agent — full lifecycle (spawn → work → steer → stop → notify) ──

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
function widgetLines(_w: number): string[] {
	return widgetRender ? widgetRender().slice(0, 4) : [];
}

// Widget presence follows the lifecycle: absent while spawning, present while
// running, gone once the notification takes over.
let agentSpawned = false;
const backgroundWidgetLines = (w: number): string[] => (agentSpawned ? widgetLines(w) : []);
const widgetOn = () => {
	if (!agentSpawned) {
		agentSpawned = true;
		widget.add(fakeAgent("a1", params.title, Date.now() - 27_500, activityTool));
	}
};
const widgetOff = () => {
	if (agentSpawned) {
		agentSpawned = false;
		widget.remove("a1");
	}
};

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

// ── Sections ────────────────────────────────────────────────

// Path A — background agent, full lifecycle, widget in sync.
const bgLifecycle: LifecycleSection = {
	title: "A · background agent — spawn → work → steer → stop → notify (loops, blank pause between rounds)",
	phases: [
		{
			name: "spawn starting",
			ticks: 20,
			render: (_t, w) =>
				pendingCard(agentView, { ...params, run_in_background: true }, details({ runInBackground: true }), w),
		},
		{
			name: "started",
			ticks: 19,
			render: (_t, w) => {
				widgetOn();
				return [
					...backgroundWidgetLines(w),
					...doneCard(agentView, { ...params, run_in_background: true }, details({ runInBackground: true }), w),
				];
			},
		},
		{
			name: "working",
			ticks: 40,
			render: (_t, w) => [
				...backgroundWidgetLines(w),
				...doneCard(agentView, { ...params, run_in_background: true }, details({ runInBackground: true }), w),
			],
		},
		{
			name: "steer pending",
			ticks: 20,
			render: (_t, w) => [
				...backgroundWidgetLines(w),
				...pendingCard(
					agentControlView,
					{ agent_id: "a1", action: "steer", message: "重点看 orders 表的索引和慢查询" },
					{ action: "steer", title: params.title },
					w,
				),
			],
		},
		{
			name: "steered",
			ticks: 19,
			render: (_t, w) => [
				...backgroundWidgetLines(w),
				...doneCard(
					agentControlView,
					{ agent_id: "a1", action: "steer", message: "重点看 orders 表的索引和慢查询" },
					{
						action: "steer",
						title: params.title,
						message: "重点看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
					w,
				),
			],
		},
		{
			name: "stop pending",
			ticks: 20,
			render: (_t, w) => [
				...backgroundWidgetLines(w),
				...pendingCard(
					agentControlView,
					{ agent_id: "a1", action: "stop" },
					{ action: "stop", title: params.title },
					w,
				),
			],
		},
		{
			name: "stopped",
			ticks: 19,
			render: (_t, w) => [
				...backgroundWidgetLines(w),
				...doneCard(
					agentControlView,
					{ agent_id: "a1", action: "stop" },
					{ action: "stop", title: params.title, status: "stop" },
					w,
				),
			],
		},
		{
			name: "notification",
			ticks: 20,
			render: (_t, w) => {
				widgetOff();
				return renderLines(
					renderNotification(
						{
							details: {
								status: "completed",
								agent_id: "a1",
								title: params.title,
								model: params.model,
								thinking: params.thinking,
								result: "Found 5 flaky tests. All share the `retries: 0` flag.",
								usage: { durationMs: 27_500, tokens: 12_500, toolUses: 3 },
								sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
								sessionId: "sess-1",
							},
						},
						{ expanded: false },
						theme,
					),
					w,
				);
			},
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path B — foreground agent: starting → streaming activity → collapsed → expanded.
const fgLifecycle: LifecycleSection = {
	title: "B · foreground agent — starting → stream → collapsed → expanded (loops, blank pause)",
	phases: [
		{
			name: "starting",
			ticks: 20,
			render: (_t, w) => pendingCard(agentView, params, details(), w),
		},
		{
			name: "streaming",
			ticks: 60,
			render: (t, w) => {
				const step = Math.floor(t / 3);
				const shown = streamLines.slice(0, step + 1).join("\n");
				return pendingCard(
					agentView,
					params,
					details({ events: [...activityEvents(step), { kind: "text", text: shown }] }),
					w,
				);
			},
		},
		{
			name: "collapsed",
			ticks: 19,
			render: (_t, w) =>
				doneCard(
					agentView,
					params,
					details({
						events: [...activityEvents(streamActivities.length), { kind: "text", text: streamLines.join("\n") }],
					}),
					w,
				),
		},
		{
			name: "expanded",
			ticks: 19,
			render: (_t, w) =>
				doneCard(
					agentView,
					params,
					details({
						events: [...activityEvents(streamActivities.length), { kind: "text", text: streamLines.join("\n") }],
					}),
					w,
					{ expanded: true },
				),
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path C — background failure: spawn fails → error card → failed notification.
const bgFailure: LifecycleSection = {
	title: "C · background failure — start failed → failed notification (loops, blank pause)",
	phases: [
		{
			name: "starting",
			ticks: 20,
			render: (_t, w) =>
				pendingCard(agentView, { ...params, run_in_background: true }, details({ runInBackground: true }), w),
		},
		{
			name: "start failed",
			ticks: 19,
			render: (_t, w) =>
				doneCard(
					agentView,
					{ ...params, run_in_background: true },
					details({
						runInBackground: true,
						title: "bad model",
						error: 'Model "no-such-model-xyz" not available.',
					}),
					w,
					{ isError: true },
				),
		},
		{
			name: "failed notification",
			ticks: 20,
			render: (_t, w) =>
				renderLines(
					renderNotification(
						{
							details: {
								status: "failed",
								agent_id: "a1",
								title: params.title,
								model: params.model,
								thinking: params.thinking,
								result: 'Model "no-such-model-xyz" not available.',
								usage: { durationMs: 4_200, tokens: 180, toolUses: 0 },
								sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
								sessionId: "sess-1",
							},
						},
						{ expanded: false },
						theme,
					),
					w,
				),
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path D — foreground failure: streams a little, then dies mid-run.
const fgFailure: LifecycleSection = {
	title: "D · foreground failure — starting → partial stream → error (loops, blank pause)",
	phases: [
		{
			name: "starting",
			ticks: 20,
			render: (_t, w) => pendingCard(agentView, params, details(), w),
		},
		{
			name: "partial stream",
			ticks: 20,
			render: (_t, w) =>
				pendingCard(
					agentView,
					params,
					details({ events: [...activityEvents(2), { kind: "text", text: streamLines.slice(0, 2).join("\n") }] }),
					w,
				),
		},
		{
			name: "failed",
			ticks: 19,
			render: (_t, w) =>
				doneCard(
					agentView,
					params,
					details({
						events: [...activityEvents(2), { kind: "text", text: streamLines.slice(0, 2).join("\n") }],
						error: "Agent exited with status 1: bash failed after 3 attempts.",
					}),
					w,
					{ isError: true },
				),
		},
	],
	pauseTicks: 30,
	height: 0,
};

// ── Pagination + live loop ───────────────────────────────────

// Paginate: stack sections until the page would overflow the terminal, then
// start a new page. The canvas is fully redrawn in place per page, so
// animations loop in place and every section is fully visible even on a
// short terminal — nothing is ever clipped or scrolled away. Pages are
// switched with the keyboard (→/space/n next, ←/p previous, q quit).
function paginate(sections: LifecycleSection[], budget: number): LifecycleSection[][] {
	const pages: LifecycleSection[][] = [];
	let page: LifecycleSection[] = [];
	let used = 0;
	for (const s of sections) {
		const need = 1 + s.height + 1; // title row + canvas + blank row
		if (used + need > budget && page.length > 0) {
			pages.push(page);
			page = [];
			used = 0;
		}
		page.push(s);
		used += need;
	}
	if (page.length > 0) pages.push(page);
	return pages.length > 0 ? pages : [sections];
}

async function runLive(sections: LifecycleSection[]): Promise<void> {
	console.log(
		"\n\x1b[1m\x1b[4mLive — lifecycles looping, blank pause between rounds, key-paginated (Ctrl+C to exit)\x1b[0m",
	);
	if (!process.stdout.isTTY) {
		// Sample each lifecycle at several ticks spanning the full cycle.
		for (const s of sections) {
			console.log(`\n\x1b[1m\x1b[4m${s.title}\x1b[0m`);
			const total = cycleTicks(s);
			for (const frac of [0, 0.2, 0.45, 0.7, 0.95]) {
				for (const l of lifecycleRender(s, Math.floor(total * frac), 100)) console.log(l);
				console.log("· · ·");
			}
		}
		return;
	}
	// Own the whole screen: sections stack per page (title + canvas + blank
	// row each); →/space/n and ←/p flip pages, q quits. Raw stdin so single
	// keypresses land without Enter.
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write(
		"\x1b[1m\x1b[4mLive — lifecycles looping, blank pause between rounds, key-paginated (Ctrl+C to exit)\x1b[0m\n",
	);
	process.stdout.write("\x1b[?25l"); // hide cursor
	const rows = process.stdout.rows ?? 40;
	const width = process.stdout.columns ?? 100;
	const pages = paginate(sections, rows - 3); // top title + page indicator
	let page = 0;
	let quit = false;
	// Raw stdin for single-key paging; only when stdin is a real TTY (piped
	// stdin falls back to Ctrl+C to exit).
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (chunk: Buffer) => {
			const s = chunk.toString();
			// Ctrl+C (\u0003) quits — raw mode turns SIGINT into a char, so it's
			// handled here; the spinner/widget timers are cleaned up on exit.
			if (s === "\u0003") {
				quit = true;
			} else if (s === " " || s === "n" || s === "\r" || s === "\x1b[C") {
				page = (page + 1) % pages.length;
			} else if (s === "p" || s === "\x1b[D") {
				page = (page - 1 + pages.length) % pages.length;
			}
		});
	}
	try {
		let lastPage = -1;
		for (let t = 0; !quit; t++) {
			if (page !== lastPage) {
				process.stdout.write("\x1b[2J\x1b[H");
				lastPage = page;
			}
			let y = 2;
			for (const s of pages[page]) {
				process.stdout.write(`\x1b[${y};1H\x1b[2K\x1b[1m\x1b[4m${s.title}\x1b[0m`);
				const lines = lifecycleRender(s, t, width);
				for (let k = 0; k < s.height; k++) {
					process.stdout.write(`\x1b[${y + 1 + k};1H\x1b[2K${lines[k] ?? " "}`);
				}
				y += 1 + s.height + 1;
			}
			process.stdout.write(
				`\x1b[${rows};1H\x1b[2K\x1b[2m— page ${page + 1}/${pages.length} (→/space next · ←/p prev · Ctrl+C quit) —\x1b[0m`,
			);
			await sleep(80);
		}
	} finally {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}
		process.stdout.write("\x1b[?25h\n");
		// Spinner animations keep their intervals alive (they hold the event
		// loop), so exit explicitly instead of letting the process hang.
		process.exit(0);
	}
}

// Measure fixed canvas heights over a full cycle (every phase of each
// lifecycle, including the paused blank), then run all sections forever.
const sections = [bgLifecycle, fgLifecycle, bgFailure, fgFailure];
for (const s of sections) {
	let maxH = 0;
	for (let t = 0; t < cycleTicks(s); t++) maxH = Math.max(maxH, lifecycleRender(s, t, 100).length);
	s.height = maxH;
}
await runLive(sections);
widget.dispose();
