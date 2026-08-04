/**
 * Component preview — a mini "storybook" for the extension's TUI renderers.
 *
 * Renders every complete component (result cards, notification cards, the
 * widget) through the real render pipeline with the real pi theme, plus live
 * animations for everything that moves (spinners, streaming collapsed
 * output), so you can eyeball the visuals without launching a full session.
 *
 *   npm run preview              # static grid + live animations (TTY)
 *   npm run preview -- static    # static grid only
 *   THEME=ayu-dark npm run preview   # or any pi theme name
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import type { AgentActivity, AgentProcess } from "./agent-process.js";
import {
	type AgentParams,
	type RenderEvent,
	renderAgentCall,
	renderAgentControlResult,
	renderAgentResult,
	renderNotification,
	type SubagentDetails,
} from "./render.js";
import { AgentWidget } from "./widget.js";

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

// Timer state persisted through the render context — one shared object so
// elapsed/Took timers behave like a real tool card.
const state: Record<string, unknown> = { startedAt: Date.now() - 27_500, endedAt: Date.now() };
const context = {
	state,
	invalidate: () => {},
	executionStarted: true,
	isError: false,
} as never;

// Failed foreground card: the framework would mark this result isError, which
// drives the header icon (✗) and the error background.
const errorContext = {
	state,
	invalidate: () => {},
	executionStarted: true,
	isError: true,
} as never;

function renderLines(component: unknown, width = 100): string[] {
	const c = component as { render(w: number): string[] };
	return c.render(width);
}

/** Build a component via a callback (fresh render each story), then show it. */

/**
 * Simulate pi's framework tool shell (tool-execution.js): for renderShell
 * "default" tools, the framework wraps both the call renderer (header) and
 * the result renderer in one Box(1,1) whose background follows state
 * (pending while running, success/error on completion).
 */
function shell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[]) {
	const box = new Box(1, 1, (t: string) => theme.bg(bg, t));
	for (const child of children) box.addChild(child as never);
	return { render: (w: number) => renderLines(box, w) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Story data ─────────────────────────────────────────────

const params: AgentParams = {
	prompt: "Check the CI config for flaky tests. Look at the pipeline definition and report issues with evidence.",
	title: "检查 CI 配置",
	model: "claude-sonnet",
};

const activityTool: SubagentDetails["activity"] = { kind: "tool", name: "bash", args: "sleep 20" };
const activityThinking: SubagentDetails["activity"] = { kind: "thinking", text: "" };

function foregroundDetails(extra: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		task: params.prompt,
		startedAt: state.startedAt as number,
		endedAt: state.endedAt as number,
		sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
		...extra,
	};
}

// ─── 5. Live animations — all looping in place, side by side ───

interface LiveSection {
	title: string;
	/** Render one frame at global tick t. Returns the canvas lines. */
	render: (t: number) => string[];
	/** Fixed canvas height (max frame height, measured at setup). */
	height: number;
}

async function runLive(sections: LiveSection[]): Promise<void> {
	console.log("\n\x1b[1m\x1b[4mLive — all animations looping in place, side by side (Ctrl+C to exit)\x1b[0m");
	if (!process.stdout.isTTY) {
		for (const s of sections) {
			console.log(`\n\x1b[1m\x1b[4m${s.title}\x1b[0m`);
			for (let f = 0; f < 4; f++) for (const l of s.render(f * 5)) console.log(l);
		}
		return;
	}
	// Clear the static grid, then own the whole screen: each section = title
	// row + canvas + blank row, fixed layout, redrawn in place.
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write("\x1b[1m\x1b[4mLive — all animations looping in place, side by side (Ctrl+C to exit)\x1b[0m\n");
	process.stdout.write("\x1b[?25l"); // hide cursor
	try {
		const starts: number[] = [];
		let y = 2;
		for (const s of sections) {
			starts.push(y);
			y += 1 + s.height + 1;
		}
		for (let t = 0; ; t++) {
			for (let i = 0; i < sections.length; i++) {
				const s = sections[i];
				const st = starts[i];
				process.stdout.write(`\x1b[${st};1H\x1b[2K\x1b[1m\x1b[4m${s.title}\x1b[0m`);
				const lines = s.render(t);
				for (let k = 0; k < s.height; k++) {
					process.stdout.write(`\x1b[${st + 1 + k};1H\x1b[2K${lines[k] ?? " "}`);
				}
			}
			await sleep(80);
		}
	} finally {
		process.stdout.write("\x1b[?25h\n");
	}
}

// ── Sections ────────────────────────────────────────────────

// ── Spawn group: spinner → started → start failed, cycling ──
const spawnCardLines = () =>
	renderLines(
		renderAgentResult(
			{ details: { runInBackground: true, title: params.title }, content: [] },
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		100,
	);
const spawnFailedLines = () =>
	renderLines(
		renderAgentResult(
			{
				details: { runInBackground: true, title: "bad model", error: 'Model "no-such-model-xyz" not available.' },
				content: [{ type: "text", text: 'Model "no-such-model-xyz" not available.' }],
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		100,
	);
// Real component partial: the pending card with the spinner inside.
const spawnSpin = (t: number) => {
	void t;
	return renderLines(
		renderAgentResult(
			{ details: { runInBackground: true, title: params.title }, content: [] },
			{ expanded: false, isPartial: true },
			theme,
			context,
		),
		100,
	);
};
// 20 spin + 19 started + 19 failed ticks per cycle
const SPAWN_CYCLE = 20 + 19 + 19;
const spawnSection: LiveSection = {
	title: "background spawn: spinner → started → start failed",
	render: (t) => {
		const phase = t % SPAWN_CYCLE;
		if (phase < 20) return spawnSpin(t);
		if (phase < 39) return spawnCardLines();
		return spawnFailedLines();
	},
	height: 0,
};

// ── AgentControl group: spinner → stopped → steered → stop failed, cycling ──
const acStoppedLines = () =>
	renderLines(
		renderAgentControlResult(
			{
				content: [{ type: "text", text: "Stopped agent a1." }],
				details: { agentId: "a1", action: "stop", title: params.title },
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		100,
	);
const acSteeredLines = () =>
	renderLines(
		renderAgentControlResult(
			{
				content: [{ type: "text", text: 'Steered agent a1: "…"' }],
				details: {
					agentId: "a1",
					action: "steer",
					title: params.title,
					message: "重点看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		100,
	);
const acStopFailedLines = () =>
	renderLines(
		renderAgentControlResult(
			{
				content: [{ type: "text", text: "Agent a1 already finished." }],
				details: { agentId: "a1", action: "stop", title: params.title, error: "Agent a1 already finished." },
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		100,
	);
const acSpin = (t: number) => {
	void t;
	return renderLines(
		renderAgentControlResult(
			{
				content: [{ type: "text", text: "Stopping…" }],
				details: { agentId: "a1", action: "stop", title: params.title },
			},
			{ expanded: false, isPartial: true },
			theme,
			context,
		),
		100,
	);
};
// 20 spin + 19 stopped + 19 steered + 19 stop-failed ticks per cycle
const AC_CYCLE = 20 + 19 + 19 + 19;
const agentControlSection: LiveSection = {
	title: "AgentControl: spinner → stopped → steered → stop failed",
	render: (t) => {
		const phase = t % AC_CYCLE;
		if (phase < 20) return acSpin(t);
		if (phase < 39) return acStoppedLines();
		if (phase < 58) return acSteeredLines();
		return acStopFailedLines();
	},
	height: 0,
};

// ── Foreground group: completed (collapsed) → expanded → failed, cycling ──
const fgCards = [
	() =>
		shell("toolSuccessBg", [
			renderAgentCall(params, theme, context),
			renderAgentResult(
				{
					details: foregroundDetails(),
					// Long output so the collapsed fold shows the "... N earlier
					// lines (to expand)" hint (prompt 1 + 12 lines → 8 folded).
					content: [
						{
							type: "text",
							text: [
								"Found 5 flaky tests. All share the `retries: 0` flag.",
								"The five specs all run before fixtures are seeded — a known race.",
								"Evidence: git log shows the fixture change landed 2 days ago.",
								"1. orders.test.ts — flaky since Mar 3",
								"2. users.test.ts — flaky since Mar 5",
								"3. invoices.test.ts — flaky since Mar 8",
								"4. reports.test.ts — flaky since Mar 12",
								"5. audit.test.ts — flaky since Mar 14",
								"Root cause: specs assert before the async fixture promise settles.",
								"Repro: npx vitest run --repeat 20 orders.test.ts",
								"Consistent failure on the 7th run.",
								"Patch: set retries: 2 in vitest.config.ts.",
							].join("\n"),
						},
					],
				},
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		]),
	() =>
		shell("toolSuccessBg", [
			renderAgentCall(params, theme, context),
			renderAgentResult(
				{
					details: foregroundDetails(),
					content: [
						{
							type: "text",
							text: "Found 5 flaky tests. All share the `retries: 0` flag.\n\nPatch: set retries: 2 in vitest.config.ts.",
						},
					],
				},
				{ expanded: true, isPartial: false },
				theme,
				context,
			),
		]),
	() =>
		shell("toolErrorBg", [
			renderAgentCall(params, theme, errorContext),
			renderAgentResult(
				{
					details: foregroundDetails({ activity: activityTool }),
					content: [
						{
							type: "text",
							text: 'Model "no-such-model-xyz" not available.\n(stopped — reached the task time/token limit; the output above is partial)',
						},
					],
				},
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		]),
];
const foregroundSection: LiveSection = {
	title: "foreground agent: completed (collapsed) → expanded → failed",
	render: (t) => renderLines(fgCards[Math.floor(t / 25) % fgCards.length](), 100),
	height: 0,
};

// Widget: real AgentWidget instance — its internal 80ms tick drives the
// frame counter and the elapsed timers; we just re-render each global tick.
let widgetRender: (() => string[]) | undefined;
const widgetUi = {
	setWidget: (
		_key: string,
		factory: ((tui: unknown, th: Theme) => { render(): string[] }) | undefined,
		_opts: unknown,
	) => {
		// AgentWidget.dispose() calls setWidget(key, undefined) to unregister.
		widgetRender = factory ? factory({ requestRender: () => {} }, theme).render : undefined;
	},
} as never;
const widget = new AgentWidget(widgetUi as never);
const now = Date.now();
const fakeAgent = (agentId: string, title: string, startedAt: number, activity: unknown) =>
	({
		agentId,
		title,
		startedAt,
		status: "running",
		getLatestActivity: () => activity,
	}) as unknown as AgentProcess;
widget.add(fakeAgent("a1", params.title, now - 42_000, activityTool));
widget.add(fakeAgent("a2", "slow query probe", now - 8_000, activityThinking));
const widgetSection: LiveSection = {
	title: "Agents widget (spinner frames + ticking elapsed)",
	render: () => widgetRender?.() ?? [],
	height: 0,
};

// Foreground stream: output grows line by line, the collapsed tail preview
// scrolls, and the elapsed timer ticks. Separate context so the Took/Elapsed
// timer starts fresh instead of reusing the static card's.
const liveState: Record<string, unknown> = { startedAt: Date.now() };
const liveContext = {
	state: liveState,
	invalidate: () => {},
	executionStarted: true,
	isError: false,
	isPartial: true,
} as never;
// Activity mirrors the stream: the latest tool/thinking state advances as
// the agent works (preview only feeds data — the renderer decides display).
const streamActivities: AgentActivity[] = [
	activityTool,
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
const streamSection: LiveSection = {
	title: "foreground stream (collapsed, growing output)",
	render: (t) => {
		const step = Math.floor(t / 4) % streamLines.length;
		const shown = streamLines.slice(0, step + 1).join("\n");
		// The activity stream in event order: activities seen so far, then the
		// streamed text (preview only feeds data — the renderer decides display).
		const seen = streamActivities.slice(0, Math.min(step, streamActivities.length));
		const events: RenderEvent[] = [
			...seen.flatMap((a): RenderEvent[] => {
				if (a.kind === "tool") return [{ kind: "tool", name: a.name, args: a.args }];
				if (a.kind === "thinking") return [{ kind: "thinking" }];
				return []; // text activity: no event, text is carried separately
			}),
			{ kind: "text", text: shown },
		];
		// Pending background while the stream is live (framework shell).
		return renderLines(
			shell("toolPendingBg", [
				renderAgentCall(params, theme, liveContext),
				renderAgentResult(
					{
						details: foregroundDetails({
							startedAt: liveState.startedAt as number,
							endedAt: undefined,
							activity: seen[seen.length - 1],
							events,
						}),
						content: [{ type: "text", text: shown }],
					},
					{ expanded: false, isPartial: true },
					theme,
					liveContext,
				),
			]),
			100,
		);
	},
	height: 0,
};

// Notification cards: no internal animation, so cycle the three statuses
// in place — completed → failed → stopped, each held ~1.6s.
const notifStatuses = ["completed", "failed", "stopped"] as const;
const notifSection: LiveSection = {
	title: "notification cards (completed → failed → stopped)",
	render: (t) =>
		renderLines(
			renderNotification(
				{
					details: {
						status: notifStatuses[Math.floor(t / 20) % 3],
						agent_id: "a1",
						title: params.title,
						result: "Found 5 flaky tests. All share the `retries: 0` flag.",
						usage: { durationMs: 27_500, tokens: 12_500, toolUses: 3 },
						sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
						sessionId: "sess-1",
					},
				},
				{ expanded: false },
				theme,
			),
			100,
		),
	height: 0,
};

// Measure fixed canvas heights over a full cycle (covers both the spin and
// card phases of the flow animations, every stream step, and every card of
// the two carousels), then run all sections concurrently forever.
for (const s of [spawnSection, agentControlSection, foregroundSection, widgetSection, streamSection, notifSection]) {
	let maxH = 0;
	for (let t = 0; t < 200; t++) maxH = Math.max(maxH, s.render(t).length);
	s.height = maxH;
}
await runLive([spawnSection, agentControlSection, foregroundSection, widgetSection, streamSection, notifSection]);
widget.dispose();
