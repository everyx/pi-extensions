/**
 * Component preview — a mini "storybook" for the two tool cards.
 *
 * Renders every lifecycle state of web_search and web_fetch through the
 * real render pipeline with the real pi theme:
 *
 *   web_search — running (animated) / success (api channel) / success
 *                (browser engine) / empty / channel-unavailable error
 *   web_fetch  — running (animated) / success / 404 error
 *
 *   pnpm preview              # live: all animations looping in place,
 *                             # key-paginated (→/space next, ←/p prev, Ctrl+C)
 *   pnpm preview -- static    # static grid only
 *   THEME=ayu-dark pnpm preview
 */

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { initPreviewTheme } from "@everyx/pi-ui/theme.js";
import { renderFetchCall, renderFetchResult, renderSearchCall, renderSearchResult } from "./render.js";

const theme: Theme = await initPreviewTheme();

// ── helpers ──────────────────────────────────────────────────────

function renderLines(component: unknown, width = 100): string[] {
	const c = component as { render(w: number): string[] };
	return c.render(width);
}

/** Simulate pi's framework tool shell (default shell). */
function shell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[]) {
	const box = new Box(1, 1, (t: string) => theme.bg(bg, t));
	for (const child of children) box.addChild(child as never);
	return { render: (w: number) => renderLines(box, w) };
}

function toolShell(bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg", children: unknown[], w = 100): string[] {
	return renderLines(shell(bg, children), w);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared state for the animated sections — the spinner is cached here so
 * frames advance with wall-clock time across re-renders (per-render state
 * would restart the spinner every tick and never animate). */
const liveState = { startedAt: Date.now() - 27500, spinner: undefined as unknown };

function ctx(
	isPartial: boolean,
	isError = false,
	details: Record<string, unknown> = {},
	state: Record<string, unknown> = {},
	args: Record<string, unknown> = {},
): {
	result: AgentToolResult<Record<string, unknown>>;
	context: {
		state: Record<string, unknown>;
		args: Record<string, unknown>;
		isPartial?: boolean;
		isError: boolean;
		invalidate: () => void;
	};
} {
	return {
		result: {
			role: "toolResult",
			toolCallId: "preview",
			toolName: "web_search",
			content: [{ type: "text", text: (details._body as string) ?? "" }],
			details,
			isError,
		} as unknown as AgentToolResult<Record<string, unknown>>,
		context: {
			state,
			args,
			isPartial,
			isError,
			invalidate: () => {},
		},
	};
}

// ── Story data ───────────────────────────────────────────────────

const searchBody = [
	"1. Rocket - Simple, Fast, Type-Safe (about 2 years ago · Sergio Benitez)",
	"   https://rocket.rs/",
	"   Rocket is a web framework for Rust that makes it simple to write fast, secure web applications.",
	"2. Actix Web",
	"   https://actix.rs/",
	"   Actix Web is a powerful, pragmatic, and extremely fast web framework for Rust.",
	"3. Axum - Modular web framework",
	"   https://github.com/tokio-rs/axum",
	"   Axum is a modular web framework built on tokio, tower, and hyper.",
	"4. Warp - A super-easy, composable web server",
	"   https://github.com/seanmonstar/warp",
	"   Warp is a super-easy, composable web server framework for warp speeds.",
	"5. Poem - A full-featured and easy-to-use web framework",
	"   https://github.com/poem-web/poem",
	"   Poem is a full-featured and easy-to-use web framework with FastAPI-style ergonomics.",
].join("\n");

const fetchMarkdown = [
	"Rocket - Simple, Fast, Type-Safe Web Framework for Rust",
	"",
	"Rocket is a web framework for Rust (nightly) that makes it simple to write fast, secure web applications without sacrificing flexibility, usability, or safety.",
	"",
	"## Highlights",
	"- Routing, preprocessing, and validation of request parameters",
	"- Security and privacy best practices enforced by default",
	"- Type-safe templating and automatic escaping",
	"- Built-in support for JSON, cookies, streams, and more",
	"",
	"[Learn more](https://rocket.rs/)",
].join("\n");

// ── Live sections ────────────────────────────────────────────────

interface LiveSection {
	title: string;
	/** Render one frame at global tick t for canvas width w. Returns the canvas lines. */
	render: (t: number, w: number) => string[];
	/** Fixed canvas height (max frame height, measured at setup). */
	height: number;
}

const runningSearch = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolPendingBg",
		[
			renderSearchCall(
				{ query: "rust web framework" },
				theme,
				ctx(true, false, {}, liveState, { query: "rust web framework" }).context,
			),
		],
		w,
	);
};

const searchSuccess = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolSuccessBg",
		[
			renderSearchCall({ query: "rust web framework" }, theme, ctx(false).context),
			renderSearchResult(
				ctx(false, false, { channel: "exa", count: 5, _body: searchBody }, {}, { query: "rust web framework" }).result,
				{ expanded: true, isPartial: false },
				theme,
				ctx(false, false, {}, {}, { query: "rust web framework" }).context,
			),
		],
		w,
	);
};

const searchBsk = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolSuccessBg",
		[
			renderSearchCall({ query: "rust web framework", engine: "google" } as never, theme, ctx(false).context),
			renderSearchResult(
				ctx(
					false,
					false,
					{ channel: "bsk", engine: "google", count: 10, _body: searchBody },
					{},
					{ query: "rust web framework", engine: "google" },
				).result,
				{ expanded: true, isPartial: false },
				theme,
				ctx(false, false, {}, {}, { query: "rust web framework", engine: "google" }).context,
			),
		],
		w,
	);
};

const searchEmpty = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolSuccessBg",
		[
			renderSearchCall({ query: "nonexistent query" }, theme, ctx(false).context),
			renderSearchResult(
				ctx(false, false, { channel: "exa", count: 0, _body: "No results." }, {}, { query: "nonexistent query" })
					.result,
				{ expanded: true, isPartial: false },
				theme,
				ctx(false, false, {}, {}, { query: "nonexistent query" }).context,
			),
		],
		w,
	);
};

const searchError = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolErrorBg",
		[
			renderSearchCall({ query: "rust", engine: "yandex" } as never, theme, ctx(false, true).context),
			renderSearchResult(
				ctx(
					false,
					true,
					{
						channel: "bsk",
						engine: "yandex",
						error: "real-browser channel: yandex blocked with a captcha challenge",
						_body: "real-browser channel: yandex blocked with a captcha challenge",
					},
					{},
					{ query: "rust", engine: "yandex" },
				).result,
				{ expanded: true, isPartial: false },
				theme,
				ctx(false, true, {}, {}, { query: "rust", engine: "yandex" }).context,
			),
		],
		w,
	);
};

const runningFetch = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolPendingBg",
		[
			renderFetchCall(
				{ url: "https://rocket.rs/" },
				theme,
				ctx(true, false, {}, liveState, { query: "rust web framework" }).context,
			),
		],
		w,
	);
};

const fetchSuccess = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolSuccessBg",
		[
			renderFetchCall({ url: "https://rocket.rs/" }, theme, ctx(false).context),
			renderFetchResult(
				ctx(
					false,
					false,
					{
						url: "https://rocket.rs/",
						title: "Rocket - Simple, Fast, Type-Safe",
						markdownLength: 523,
						_body: fetchMarkdown,
					},
					{},
					{ url: "https://rocket.rs/" },
				).result,
				{ expanded: true, isPartial: false },
				theme,
				ctx(false, false, {}, {}, { url: "https://rocket.rs/" }).context,
			),
		],
		w,
	);
};

const fetchFolded = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolSuccessBg",
		[
			renderFetchCall({ url: "https://rocket.rs/" }, theme, ctx(false).context),
			renderFetchResult(
				ctx(
					false,
					false,
					{
						url: "https://rocket.rs/",
						title: "Rocket - Simple, Fast, Type-Safe",
						markdownLength: 523,
						_body: fetchMarkdown,
					},
					{},
					{ url: "https://rocket.rs/" },
				).result,
				{ expanded: false, isPartial: false },
				theme,
				ctx(false, false, {}, {}, { url: "https://rocket.rs/" }).context,
			),
		],
		w,
	);
};

const searchFolded = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolSuccessBg",
		[
			renderSearchCall({ query: "rust web framework" }, theme, ctx(false).context),
			renderSearchResult(
				ctx(false, false, { channel: "exa", count: 5, _body: searchBody }, {}, { query: "rust web framework" }).result,
				{ expanded: false, isPartial: false },
				theme,
				ctx(false, false, {}, {}, { query: "rust web framework" }).context,
			),
		],
		w,
	);
};

const fetchError = (t: number, w: number) => {
	void t;
	return toolShell(
		"toolErrorBg",
		[
			renderFetchCall({ url: "https://example.com/definitely-not-here" }, theme, ctx(false, true).context),
			renderFetchResult(
				ctx(
					false,
					true,
					{
						url: "https://example.com/definitely-not-here",
						error: "HTTP 404: Not Found",
						_body: "HTTP 404: Not Found",
					},
					{},
					{ url: "https://example.com/definitely-not-here" },
				).result,
				{ expanded: true, isPartial: false },
				theme,
				ctx(false, true, {}, {}, { url: "https://example.com/definitely-not-here" }).context,
			),
		],
		w,
	);
};

// ── Pagination + live loop ───────────────────────────────────────

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
			for (let f = 0; f < 4; f++) for (const l of s.render(f * 20, 100)) console.log(l);
		}
		return;
	}
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write("\x1b[1m\x1b[4mLive — all animations looping in place, key-paginated (Ctrl+C to exit)\x1b[0m\n");
	process.stdout.write("\x1b[?25l");
	const rows = process.stdout.rows ?? 40;
	const width = process.stdout.columns ?? 100;
	const pages = paginate(sections, rows - 3);
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
		process.exit(0);
	}
}

// ── Static grid ──────────────────────────────────────────────────

function show(label: string, lines: string[]): void {
	console.log(
		`\n${theme.fg("accent", `── ${label} `)}${theme.fg("dim", "─".repeat(Math.max(0, 60 - label.length - 4)))}`,
	);
	for (const line of lines) console.log(line);
}

// ── Entry ────────────────────────────────────────────────────────

const staticMode = process.argv.includes("static");

const sections: LiveSection[] = [
	{ title: "web_search · running (animated)", render: runningSearch, height: 0 },
	{ title: "web_search · success (expanded)", render: searchSuccess, height: 0 },
	{ title: "web_search · success (folded + expand hint)", render: searchFolded, height: 0 },
	{ title: "web_search · success (browser engine)", render: searchBsk, height: 0 },
	{ title: "web_search · empty", render: searchEmpty, height: 0 },
	{ title: "web_search · channel error", render: searchError, height: 0 },
	{ title: "web_fetch · running (animated)", render: runningFetch, height: 0 },
	{ title: "web_fetch · success (expanded)", render: fetchSuccess, height: 0 },
	{ title: "web_fetch · success (folded + expand hint)", render: fetchFolded, height: 0 },
	{ title: "web_fetch · 404 error", render: fetchError, height: 0 },
];

// Measure fixed canvas heights over a full cycle, then run live.
for (const s of sections) {
	let maxH = 0;
	for (let t = 0; t < 200; t++) maxH = Math.max(maxH, s.render(t, 100).length);
	s.height = maxH;
}

if (staticMode) {
	console.log(`\x1b[1m\x1b[4mStatic grid\x1b[0m`);
	for (const s of sections) {
		show(s.title, s.render(0, 100));
	}
	console.log("\n");
} else {
	await runLive(sections);
}
