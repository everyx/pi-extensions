/**
 * Component preview — a mini "storybook" for the two tool cards.
 *
 * Renders every lifecycle state of web_search and web_fetch through the
 * real render pipeline with the real pi theme, so you can eyeball the
 * visuals without launching a full session:
 *
 *   web_search — running / success (api channel) / success (browser engine)
 *                / empty / channel-unavailable error
 *   web_fetch  — running / success / 404 error
 *
 *   pnpm preview              # full grid
 *   THEME=ayu-dark pnpm preview
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { renderFetchCall, renderFetchResult, renderSearchCall, renderSearchResult } from "./render.js";

const themeName = process.env.THEME || "light";
initTheme(themeName);

// The live theme object lives in an internal module that the package entry
// doesn't re-export and whose subpath is blocked by its "exports" map. Walk
// node_modules physically and import the file by absolute URL, bypassing the
// exports map entirely (same approach as pi-subagent's preview).
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

// ── helpers ──────────────────────────────────────────────────────

function ctx(
	isPartial: boolean,
	isError = false,
	details: Record<string, unknown> = {},
): {
	result: AgentToolResult<Record<string, unknown>>;
	context: { state: { startedAt?: number }; isPartial?: boolean; isError: boolean; invalidate: () => void };
} {
	return {
		result: {
			role: "toolResult",
			toolCallId: "preview",
			toolName: "web_search",
			content: [{ type: "text", text: details._body ?? "" }],
			details,
			isError,
		} as unknown as AgentToolResult<Record<string, unknown>>,
		context: {
			state: { startedAt: Date.now() - 27500 },
			isPartial,
			isError,
			invalidate: () => {},
		},
	};
}

function show(label: string, component: Text): void {
	console.log(
		`\n${theme.fg("accent", `── ${label} `)}${theme.fg("dim", "─".repeat(Math.max(0, 60 - label.length - 4)))}`,
	);
	console.log(component.render(100).join("\n"));
}

// ── web_search lifecycle ─────────────────────────────────────────

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

show("web_search · running", renderSearchCall({ query: "rust web framework" }, theme, ctx(true).context));

show(
	"web_search · success (search API channel)",
	renderSearchResult(
		ctx(false, false, { channel: "exa", count: 5, _body: searchBody }).result,
		{ expanded: true, isPartial: false },
		theme,
		ctx(false).context,
	),
);

show(
	"web_search · success (browser engine)",
	renderSearchResult(
		ctx(false, false, { channel: "bsk", engine: "google", count: 10, _body: searchBody }).result,
		{ expanded: true, isPartial: false },
		theme,
		ctx(false).context,
	),
);

show(
	"web_search · empty",
	renderSearchResult(
		ctx(false, false, { channel: "exa", count: 0, _body: "No results." }).result,
		{ expanded: true, isPartial: false },
		theme,
		ctx(false).context,
	),
);

show(
	"web_search · channel unavailable",
	renderSearchResult(
		ctx(false, true, {
			channel: "bsk",
			error:
				"real-browser channel unavailable: launched browser but the bsk extension did not connect (is the BrowserSkill extension installed?)",
			_body:
				"real-browser channel unavailable: launched browser but the bsk extension did not connect (is the BrowserSkill extension installed?)",
		}).result,
		{ expanded: true, isPartial: false },
		theme,
		ctx(false, true).context,
	),
);

// ── web_fetch lifecycle ──────────────────────────────────────────

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

show("web_fetch · running", renderFetchCall({ url: "https://rocket.rs/" }, theme, ctx(true).context));

show(
	"web_fetch · success",
	renderFetchResult(
		ctx(false, false, {
			url: "https://rocket.rs/",
			title: "Rocket - Simple, Fast, Type-Safe",
			markdownLength: 523,
			_body: fetchMarkdown,
		}).result,
		{ expanded: true, isPartial: false },
		theme,
		ctx(false).context,
	),
);

show(
	"web_fetch · 404 error",
	renderFetchResult(
		ctx(false, true, {
			url: "https://example.com/definitely-not-here",
			error: "HTTP 404: Not Found",
			_body: "HTTP 404: Not Found",
		}).result,
		{ expanded: true, isPartial: false },
		theme,
		ctx(false, true).context,
	),
);

console.log("\n");
