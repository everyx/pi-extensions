/**
 * pi-web-tools — TUI rendering for the two tool cards.
 *
 * Unified card visuals (root SPEC: 统一视觉语法): a header line
 * `✓ web_search (via exa · 5 results)` (spinner while running) followed by
 * the body (result list / markdown / error). The engine/channel echo lives
 * in the header — visible in the UI, invisible to the LLM (SPEC: 引擎回声).
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type CardIcon, type Component, dataCard, renderIcon, renderNameTitle, textLine } from "@everyx/pi-ui/card.js";
import { Spinner } from "@everyx/pi-ui/spinner.js";

/** Structural subset of pi's ToolRenderContext (not exported at the entry). */
interface RenderContext {
	state: { startedAt?: number; spinner?: Spinner };
	isPartial?: boolean;
	isError: boolean;
	invalidate: () => void;
}

/** Header icon: spinner while running, ✓/✗ on completion. */
function icon(context: RenderContext): CardIcon {
	if (context.isPartial) {
		context.state.spinner = context.state.spinner ?? new Spinner();
		return { type: "spinner", spinner: context.state.spinner };
	}
	return context.isError ? { type: "error" } : { type: "success" };
}

/** "via <channel>" / "via <engine> (engine)" echo — UI-only. */
function viaEcho(details: Record<string, unknown> | undefined): string {
	if (!details?.channel) return "";
	const engine = details.engine ? ` (${String(details.engine)})` : "";
	return `via ${String(details.channel)}${engine}`;
}

/** Extract the tool's text content (first text block). */
function contentText(result: AgentToolResult<Record<string, unknown>>): string {
	return (result.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

// ── web_search ───────────────────────────────────────────────────

export function renderSearchCall(args: { query?: string }, theme: Theme, context: RenderContext): Component {
	// Running: spinner + query line. Completed: empty — the result header
	// owns the completed surface (✓ web_search (via …)), same as pi-subagent.
	if (!context.isPartial) return textLine("");
	const query = (args.query ?? "").slice(0, 60);
	const head = `${renderIcon(icon(context), theme)} ${theme.fg("accent", "web_search")} ${theme.fg("dim", `"${query}"`)}`;
	return textLine(head);
}

export function renderSearchResult(
	result: AgentToolResult<Record<string, unknown>>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	// Running state is owned by the call renderer (spinner + query line).
	if (context.isPartial) return textLine("");
	const details = (result.details ?? {}) as Record<string, unknown>;
	const echo = viaEcho(details);
	const meta = [echo, details.count != null ? `${details.count} results` : undefined].filter(Boolean) as string[];
	const query = ((context as { args?: { query?: string } }).args?.query ?? "").slice(0, 60);
	const body = contentText(result);
	// Pass data only — dataCard assembles the header and folds the body.
	return dataCard(
		{
			icon: icon(context),
			name: "web_search",
			title: query,
			meta,
			body: body || undefined,
			expanded: options.expanded,
		},
		theme,
	);
}

// ── web_fetch ────────────────────────────────────────────────────

export function renderFetchCall(args: { url?: string }, theme: Theme, context: RenderContext): Component {
	// Running only; completed surfaces come from the result renderer.
	if (!context.isPartial) return textLine("");
	const url = (args.url ?? "").slice(0, 80);
	return textLine(`${renderIcon(icon(context), theme)} ${renderNameTitle("web_fetch", url, theme)}`);
}

export function renderFetchResult(
	result: AgentToolResult<Record<string, unknown>>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	// Running state is owned by the call renderer (spinner + url line).
	if (context.isPartial) return textLine("");
	const details = (result.details ?? {}) as Record<string, unknown>;
	const pageTitle = typeof details.title === "string" ? details.title.slice(0, 60) : "";
	const url = ((context as { args?: { url?: string } }).args?.url ?? "").slice(0, 80);
	const body = contentText(result);
	return dataCard(
		{
			icon: icon(context),
			name: "web_fetch",
			title: url,
			meta: pageTitle ? [pageTitle] : undefined,
			body: body || undefined,
			expanded: options.expanded,
		},
		theme,
	);
}
