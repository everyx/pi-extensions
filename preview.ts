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
	renderAgentControlCall,
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

const activityTool: SubagentDetails["activity"] = { kind: "tool", name: "bash", args: "sleep 20" };
const activityThinking: SubagentDetails["activity"] = { kind: "thinking", text: "" };

function foregroundDetails(extra: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		task: params.prompt,
		startedAt: state.startedAt as number,
		endedAt: state.endedAt as number,
		model: params.model,
		thinking: params.thinking,
		sessionPath: "/home/everyx/.pi/agent/subagent-sessions/019f…f.jsonl",
		...extra,
	};
}

// ─── 5. Live animations — all looping in place, side by side ───

interface LiveSection {
	title: string;
	/** Render one frame at global tick t for canvas width w. Returns the canvas lines. */
	render: (t: number, w: number) => string[];
	/** Fixed canvas height (max frame height, measured at setup). */
	height: number;
}

// Paginate: stack sections until the page would overflow the terminal, then
// start a new page. The canvas is fully redrawn in place per page, so
// animations loop in place and every section is fully visible even on a
// short terminal — nothing is ever clipped or scrolled away. Pages are
// switched with the keyboard (→/space/n next, ←/p previous, q quit).
function paginate(sections: LiveSection[], budget: number): LiveSection[][] {
	const pages: LiveSection[][] = [];
	let page: LiveSection[] = [];
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

async function runLive(sections: LiveSection[]): Promise<void> {
	console.log("\n\x1b[1m\x1b[4mLive — all animations looping in place, key-paginated (Ctrl+C to exit)\x1b[0m");
	if (!process.stdout.isTTY) {
		for (const s of sections) {
			console.log(`\n\x1b[1m\x1b[4m${s.title}\x1b[0m`);
			// Sample 4 frames across each section's full cycle: sections cycle
			// every ~60-80 ticks, so step 20 lands on every distinct card
			// (spinner/started/failed, spinner/stopped/steered/stop-failed,
			// completed/expanded/failed, completed/failed/stopped…).
			for (let f = 0; f < 4; f++) for (const l of s.render(f * 20, 100)) console.log(l);
		}
		return;
	}
	// Own the whole screen: sections stack per page (title + canvas + blank
	// row each); →/space/n and ←/p flip pages, q quits. Raw stdin so single
	// keypresses land without Enter.
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write("\x1b[1m\x1b[4mLive — all animations looping in place, key-paginated (Ctrl+C to exit)\x1b[0m\n");
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
				const lines = s.render(t, width);
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

// ── Sections ────────────────────────────────────────────────

// ── Spawn group: spinner → started → start failed, cycling ──
// The spawn call header is empty (renderAgentCall renders Text("") for
// run_in_background) — only the result's status line is visible.
const spawnParams: AgentParams = { ...params, run_in_background: true };
const spawnCardLines = (w: number) =>
	toolShell(
		"toolSuccessBg",
		[
			renderAgentCall(spawnParams, theme, context),
			renderAgentResult(
				{ details: { runInBackground: true, title: params.title }, content: [] },
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		],
		w,
	);
const spawnFailedLines = (w: number) =>
	toolShell(
		"toolErrorBg",
		[
			renderAgentCall(spawnParams, theme, context),
			renderAgentResult(
				{
					details: { runInBackground: true, title: "bad model", error: 'Model "no-such-model-xyz" not available.' },
					content: [{ type: "text", text: 'Model "no-such-model-xyz" not available.' }],
				},
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		],
		w,
	);
// Real component partial: the pending card with the spinner inside.
const spawnSpin = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolPendingBg",
		[
			renderAgentCall(spawnParams, theme, context),
			renderAgentResult(
				{ details: { runInBackground: true, title: params.title }, content: [] },
				{ expanded: false, isPartial: true },
				theme,
				context,
			),
		],
		w,
	);
};
// 20 spin + 19 started + 19 failed ticks per cycle
const SPAWN_CYCLE = 20 + 19 + 19;
const spawnSection: LiveSection = {
	title: "background spawn: spinner → started → start failed",
	render: (t, w) => {
		const phase = t % SPAWN_CYCLE;
		if (phase < 20) return spawnSpin(t, w);
		if (phase < 39) return spawnCardLines(w);
		return spawnFailedLines(w);
	},
	height: 0,
};

// ── AgentControl group: spinner → stopped → steered → stop failed, cycling ──
const acStoppedLines = (w: number) =>
	toolShell(
		"toolSuccessBg",
		[
			renderAgentControlCall(params as never, theme, context),
			renderAgentControlResult(
				{
					content: [{ type: "text", text: "Stopped agent a1." }],
					details: { action: "stop", title: params.title },
				},
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		],
		w,
	);
const acSteeredLines = (w: number) =>
	toolShell(
		"toolSuccessBg",
		[
			renderAgentControlCall(params as never, theme, context),
			renderAgentControlResult(
				{
					content: [{ type: "text", text: 'Steered agent a1: "…"' }],
					details: {
						action: "steer",
						title: params.title,
						message: "重点看 orders 表的索引和慢查询\nSecond line: focus on the result.\nThird: wrap up when done.",
					},
				},
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		],
		w,
	);
const acStopFailedLines = (w: number) =>
	toolShell(
		"toolErrorBg",
		[
			renderAgentControlCall(params as never, theme, context),
			renderAgentControlResult(
				{
					content: [{ type: "text", text: "Agent a1 already finished." }],
					details: { action: "stop", title: params.title, error: "Agent a1 already finished." },
				},
				{ expanded: false, isPartial: false },
				theme,
				context,
			),
		],
		w,
	);
const acSpin = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolPendingBg",
		[
			renderAgentControlCall(params as never, theme, context),
			renderAgentControlResult(
				{
					content: [{ type: "text", text: "Stopping…" }],
					details: { action: "stop", title: params.title },
				},
				{ expanded: false, isPartial: true },
				theme,
				context,
			),
		],
		w,
	);
};
// 20 spin + 19 stopped + 19 steered + 19 stop-failed ticks per cycle
const AC_CYCLE = 20 + 19 + 19 + 19;
const agentControlSection: LiveSection = {
	title: "AgentControl: spinner → stopped → steered → stop failed",
	render: (t, w) => {
		const phase = t % AC_CYCLE;
		if (phase < 20) return acSpin(t, w);
		if (phase < 39) return acStoppedLines(w);
		if (phase < 58) return acSteeredLines(w);
		return acStopFailedLines(w);
	},
	height: 0,
};

// ── Foreground group: completed (collapsed) → expanded → failed, cycling ──
// The foreground card renders details.task + details.events (activity
// stream), NOT content — long output goes through events so the collapsed
// fold shows the "... N earlier lines (to expand)" hint.
const longOutput: RenderEvent[] = [
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
].map((text) => ({ kind: "text" as const, text }));
const fgCards = [
	(w: number) =>
		toolShell(
			"toolSuccessBg",
			[
				renderAgentCall(params, theme, context),
				renderAgentResult(
					{ details: foregroundDetails({ events: longOutput }), content: [] },
					{ expanded: false, isPartial: false },
					theme,
					context,
				),
			],
			w,
		),
	(w: number) =>
		toolShell(
			"toolSuccessBg",
			[
				renderAgentCall(params, theme, context),
				renderAgentResult(
					{ details: foregroundDetails({ events: longOutput }), content: [] },
					{ expanded: true, isPartial: false },
					theme,
					context,
				),
			],
			w,
		),
	(w: number) =>
		toolShell(
			"toolErrorBg",
			[
				renderAgentCall(params, theme, errorContext),
				renderAgentResult(
					{
						details: foregroundDetails({
							events: longOutput.slice(0, 2),
							error: 'Model "no-such-model-xyz" not available.',
						}),
						content: [],
					},
					{ expanded: false, isPartial: false },
					theme,
					errorContext,
				),
			],
			w,
		),
];
const foregroundSection: LiveSection = {
	title: "foreground agent: completed (collapsed) → expanded → failed",
	render: (t, w) => fgCards[Math.floor(t / 25) % fgCards.length](w),
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
	render: (_t, _w) => widgetRender?.() ?? [],
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
	render: (t, w) => {
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
			w,
		);
	},
	height: 0,
};

// Notification cards: no internal animation, so cycle the three statuses
// in place — completed → failed → stopped, each held ~1.6s.
const notifStatuses = ["completed", "failed", "stopped"] as const;
const notifSection: LiveSection = {
	title: "notification cards (completed → failed → stopped)",
	render: (t, w) =>
		renderLines(
			renderNotification(
				{
					details: {
						status: notifStatuses[Math.floor(t / 20) % 3],
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
		),
	height: 0,
};

// Measure fixed canvas heights over a full cycle (covers both the spin and
// card phases of the flow animations, every stream step, and every card of
// the two carousels), then run all sections concurrently forever.
for (const s of [spawnSection, agentControlSection, foregroundSection, widgetSection, streamSection, notifSection]) {
	let maxH = 0;
	for (let t = 0; t < 200; t++) maxH = Math.max(maxH, s.render(t, 100).length);
	s.height = maxH;
}
await runLive([spawnSection, agentControlSection, foregroundSection, widgetSection, streamSection, notifSection]);
widget.dispose();
