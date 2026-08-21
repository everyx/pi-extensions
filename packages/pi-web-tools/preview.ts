/**
 * web-tools preview — 1:1 screen simulation, aligned with pi-subagent's.
 *
 * Each path occupies one full screen and mirrors how pi actually renders:
 * tool calls stack top-down (each call is one slot that evolves in place:
 * pending header → completed card), results fold, and every path loops with
 * a blank pause between rounds. The path title highlights the live status
 * word (accent) as the lifecycle advances.
 *
 *   pnpm preview                # 1:1 live paths (TTY)
 *   THEME=ayu-dark pnpm preview # or any pi theme name
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { fetchView, searchView } from "./views.js";

// ── Views (same templates as index.ts) ─────────────────────────

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

/** Simulate pi's framework tool shell (tool-execution.js default shell). */
function shell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[]) {
	const box = new Box(1, 1, (t: string) => theme.bg(bg, t));
	for (const child of children) box.addChild(child as never);
	return { render: (w: number) => renderLines(box, w) };
}

function toolShell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[], w = 100): string[] {
	return renderLines(shell(bg, children), w);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared render state — the spinner instance rides it so the Braille frames
// keep animating (each render reuses the same Spinner).
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

// ── Story data ─────────────────────────────────────────────

const searchResults = [
	{
		title: "Rocket — Simple, Fast, Type-Safe Web Framework for Rust",
		url: "https://rocket.rs/",
		snippet:
			"Rocket is a web framework for Rust that makes it simple to write fast, type-safe, secure web applications.",
		pageAge: "2 months ago",
	},
	{
		title: "Rocket — A web framework for Rust (GitHub)",
		url: "https://github.com/rwf2/Rocket",
		snippet: "Rocket is a web framework for Rust with a focus on ease-of-use, expressibility, and speed.",
		pageAge: "3 weeks ago",
	},
	{
		title: "Getting Started — Rocket",
		url: "https://rocket.rs/guide/getting-started",
		snippet: "Install Rocket, create a project, write your first route and launch the application.",
		pageAge: "6 days ago",
	},
	{
		title: "Rocket (web framework) — Wikipedia",
		url: "https://en.wikipedia.org/wiki/Rocket_(web_framework)",
		snippet: "Rocket is a web framework written in Rust. It is designed to be easy to use while being powerful.",
		pageAge: "1 year ago",
	},
	{
		title: "Rocket vs Axum: choosing a Rust web framework",
		url: "https://example.com/rocket-vs-axum",
		snippet: "A practical comparison of two popular Rust web frameworks: ergonomics, performance and ecosystem.",
		pageAge: "4 months ago",
	},
];

const fetchedMarkdown = `Rocket — A web framework for Rust

# Rocket

Rocket is a web framework for Rust that makes it simple to write fast,
type-safe, secure web applications. It prioritizes ease of use without
sacrificing power: most features are built in, and the compiler catches
the rest.

## Features

- Type-safe routes with automatic request guards
- Zero-cost futures for async handlers
- Template and static-file serving out of the box
- First-class testing support

## Getting started

\`\`\`rust
#[get("/hello/<name>")]
fn hello(name: &str) -> String {
    format!("Hello, {name}!")
}
\`\`\`

Run with \`cargo run\` and visit /hello/world.`;

// ── Screen simulation (same structure as pi-subagent's preview) ──

/** One slot in the tool-call stream — evolves in place like real pi. */
type StreamCard =
	| {
			kind: "search";
			args: { query: string; engine?: string };
			details: unknown;
			isPartial: boolean;
			isError?: boolean;
			expanded?: boolean;
	  }
	| {
			kind: "fetch";
			args: { url: string };
			details: unknown;
			isPartial: boolean;
			isError?: boolean;
			expanded?: boolean;
	  };

interface PathPhase {
	name: string;
	ticks: number;
	/** The tool-call stream at this point; null slots don't exist yet. */
	stream?: (StreamCard | null)[];
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
	const view = card.kind === "search" ? searchView : fetchView;
	return card.isPartial
		? toolShell(
				"toolPendingBg",
				[
					view.renderCall(card.args as never, theme, pendingContext(card.args)),
					view.renderResult(
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
					view.renderCall(card.args as never, theme, doneContext(card.args, card.isError)),
					view.renderResult(
						{ content: [], details: card.details } as never,
						{ expanded: card.expanded ?? false, isPartial: false },
						theme,
						doneContext(card.args, card.isError),
					),
				],
				w,
			);
}

/** One screen: the tool-call stream top-aligned, blank padding, no widget. */
function screenLines(stream: (StreamCard | null)[], H: number, w: number): string[] {
	const cardLines: string[] = [];
	for (const card of stream) {
		if (!card) continue;
		// Blank row between stacked cards, like pi's message stream.
		if (cardLines.length) cardLines.push("");
		cardLines.push(...renderPathCard(card, w));
	}
	const lines = [...cardLines];
	while (lines.length < H) lines.push(" ".repeat(w));
	return lines.slice(0, H);
}

// ── Path definitions ─────────────────────────────────────────

// Path A — web_search success: pending → results (collapsed) → expanded.
const pathA: LifecyclePath = {
	title: "A · web_search — searching → results (expanded)",
	phases: [
		{
			name: "searching",
			status: "searching",
			ticks: 25,
			// The routed channel streams up front (execute calls onUpdate once
			// the channel is known) — via shows immediately; the result count
			// lands on completion.
			stream: [
				{
					kind: "search",
					args: { query: "rust web framework" },
					details: { query: "rust web framework", channel: "exa" },
					isPartial: true,
				},
			],
		},
		{
			name: "results",
			status: "results",
			ticks: 25,
			stream: [
				{
					kind: "search",
					args: { query: "rust web framework" },
					details: {
						data: {
							results: searchResults,
							channel: "exa",
							count: 5,
							startedAt: 1_752_000_000_000,
							endedAt: 1_752_000_003_100,
						},
					},
					isPartial: false,
				},
			],
		},
		{
			name: "expanded",
			status: "results",
			ticks: 25,
			stream: [
				{
					kind: "search",
					args: { query: "rust web framework" },
					details: {
						data: {
							results: searchResults,
							channel: "exa",
							count: 5,
							startedAt: 1_752_000_000_000,
							endedAt: 1_752_000_003_100,
						},
					},
					isPartial: false,
					expanded: true,
				},
			],
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path B — web_search failure: pending → error (no channel / bad engine).
const pathB: LifecyclePath = {
	title: "B · web_search failure — searching → failed",
	phases: [
		{
			name: "searching",
			status: "searching",
			ticks: 25,
			stream: [
				{
					kind: "search",
					args: { query: "nonexistent query", engine: "yandex" },
					details: { query: "nonexistent query", channel: "bsk", engine: "yandex" },
					isPartial: true,
				},
			],
		},
		{
			name: "failed",
			status: "failed",
			ticks: 25,
			stream: [
				{
					kind: "search",
					args: { query: "nonexistent query", engine: "yandex" },
					details: {
						error: "yandex returned no usable results (captcha wall).",
						data: {
							channel: "bsk",
							engine: "yandex",
							count: 0,
							startedAt: 1_752_000_000_000,
							endedAt: 1_752_000_004_200,
						},
					},
					isPartial: false,
					isError: true,
				},
			],
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path C — web_fetch success: pending → done (collapsed → expanded).
const pathC: LifecyclePath = {
	title: "C · web_fetch — fetching → done (expanded)",
	phases: [
		{
			name: "fetching",
			status: "fetching",
			ticks: 25,
			stream: [{ kind: "fetch", args: { url: "https://rocket.rs/" }, details: {}, isPartial: true }],
		},
		{
			name: "done",
			status: "done",
			ticks: 25,
			stream: [
				{
					kind: "fetch",
					args: { url: "https://rocket.rs/" },
					details: {
						data: {
							title: "Rocket — Simple, Fast, Type-Safe Web Framework for Rust",
							content: fetchedMarkdown,
							startedAt: 1_752_000_000_000,
							endedAt: 1_752_000_001_800,
						},
					},
					isPartial: false,
				},
			],
		},
		{
			name: "expanded",
			status: "done",
			ticks: 25,
			stream: [
				{
					kind: "fetch",
					args: { url: "https://rocket.rs/" },
					details: {
						data: {
							title: "Rocket — Simple, Fast, Type-Safe Web Framework for Rust",
							content: fetchedMarkdown,
							startedAt: 1_752_000_000_000,
							endedAt: 1_752_000_001_800,
						},
					},
					isPartial: false,
					expanded: true,
				},
			],
		},
	],
	pauseTicks: 30,
	height: 0,
};

// Path D — web_fetch failure: pending → error.
const pathD: LifecyclePath = {
	title: "D · web_fetch failure — fetching → failed",
	phases: [
		{
			name: "fetching",
			status: "fetching",
			ticks: 25,
			stream: [{ kind: "fetch", args: { url: "https://expired.example.invalid/" }, details: {}, isPartial: true }],
		},
		{
			name: "failed",
			status: "failed",
			ticks: 25,
			stream: [
				{
					kind: "fetch",
					args: { url: "https://expired.example.invalid/" },
					details: {
						error: "fetch failed: ENOTFOUND expired.example.invalid",
						url: "https://expired.example.invalid/",
						startedAt: 1_752_000_000_000,
						endedAt: 1_752_000_002_100,
					},
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

// ── Live loop (same as pi-subagent's preview) ─────────────────

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
		// Fresh round: the next call starts a fresh Elapsed timer.
		cardState.startedAt = Date.now();
		return blankLines(s.height, w); // blank pause between rounds
	}
	// Phase boundary: drop stale streamed data so a fresh call's header
	// doesn't flash the previous result's meta.
	if (lastPhase.get(s) !== hit.phase.name) {
		lastPhase.set(s, hit.phase.name);
		delete (cardState as Record<string, unknown>).lastData;
	}
	return screenLines(hit.phase.stream ?? [], s.height, w);
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
