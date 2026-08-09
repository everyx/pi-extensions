/**
 * pi-web-tools — TUI rendering for the two tool cards.
 *
 * Unified card visuals (root SPEC: 统一视觉语法): a header line
 * `✓ web_search (via exa · 5 results)` (spinner while running) followed by
 * the body (result list / markdown / error). The engine/channel echo lives
 * in the header — visible in the UI, invisible to the LLM (SPEC: 引擎回声).
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type CardIcon, renderCard, renderIcon } from "@everyx/pi-ui/card.js";
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

export function renderSearchCall(args: { query?: string }, theme: Theme, context: RenderContext): Text {
	// Running: spinner + query line. Completed: empty — the result header
	// owns the completed surface (✓ web_search (via …)), same as pi-subagent.
	if (!context.isPartial) return new Text("", 0, 0);
	const query = (args.query ?? "").slice(0, 60);
	const head = `${renderIcon(icon(context), theme)} ${theme.fg("accent", "web_search")} ${theme.fg("dim", `"${query}"`)}`;
	return new Text(head, 0, 0);
}

export function renderSearchResult(
	result: AgentToolResult<Record<string, unknown>>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	// Running state is owned by the call renderer (spinner + query line).
	if (context.isPartial) return new Text("", 0, 0);
	const details = (result.details ?? {}) as Record<string, unknown>;
	const echo = viaEcho(details);
	const meta = [echo, details.count != null ? `${details.count} results` : undefined].filter(Boolean).join(" \u00b7 ");
	const title = `${theme.fg("accent", "web_search")}${meta ? theme.fg("muted", ` (${meta})`) : ""}`;
	const body = contentText(result);
	if (!body) return new Text(title, 0, 0);
	// renderCard folds the body (tail preview + expand hint) — folding is
	// built into the card, nothing to assemble here.
	return renderCard(
		{ header: { icon: icon(context), title }, body: { message: body }, expanded: options.expanded },
		theme,
	) as unknown as Text;
}

// ── web_fetch ────────────────────────────────────────────────────

export function renderFetchCall(args: { url?: string }, theme: Theme, context: RenderContext): Text {
	// Running only; completed surfaces come from the result renderer.
	if (!context.isPartial) return new Text("", 0, 0);
	const url = (args.url ?? "").slice(0, 80);
	return new Text(
		`${renderIcon(icon(context), theme)} ${theme.fg("accent", "web_fetch")} ${theme.fg("dim", url)}`,
		0,
		0,
	);
}

export function renderFetchResult(
	result: AgentToolResult<Record<string, unknown>>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	// Running state is owned by the call renderer (spinner + url line).
	if (context.isPartial) return new Text("", 0, 0);
	const details = (result.details ?? {}) as Record<string, unknown>;
	const title = typeof details.title === "string" ? details.title : "";
	const titlePart = title.slice(0, 60);
	const cardTitle = `${theme.fg("accent", "web_fetch")}${titlePart ? theme.fg("muted", ` (${titlePart})`) : ""}`;
	const body = contentText(result);
	if (!body) return new Text(cardTitle, 0, 0);
	// renderCard folds the body (tail preview + expand hint).
	return renderCard(
		{ header: { icon: icon(context), title: cardTitle }, body: { message: body }, expanded: options.expanded },
		theme,
	) as unknown as Text;
}
