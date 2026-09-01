/**
 * pi-ui — shared card-header rendering.
 *
 * One header row: `[marker] <name> "title" <state word / status> (<meta>)`.
 * The marker is a status icon (accent spinner / ✓ / ✗ / ■); the quoted title
 * uses bashMode like the bash card's `$ cmd`; the name keeps toolTitle bold.
 * The state is a natural-language verb phrase joined with a plain space —
 * `·` is reserved for data separators (widget elapsed time, meta).
 */

import { keyHint, type Theme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type { Component } from "@earendil-works/pi-tui";

import { Spinner, safeTitle } from "./spinner.js";

/** Icon slot: any glyph + any color (color is data; preset constants below). */
export interface CardIcon {
	glyph: string;
	color: "accent" | "success" | "error" | "warning" | "muted";
}

/** Preset icons for the common states. */
export const successIcon: CardIcon = { glyph: "\u2713", color: "success" };
export const errorIcon: CardIcon = { glyph: "\u2717", color: "error" };
export const stoppedIcon: CardIcon = { glyph: "\u25a0", color: "warning" };

interface CardHeader {
	icon: CardIcon;
	/** Raw title. When `name` is set, rendered as `name "title"` (bashMode quotes). */
	title?: string;
	/** Optional bold name prefix: `Agent "task"` — use when title is a raw label. */
	name?: string;
	/** Status slot — free text (starting…, start failed…); color is data. */
	tail?: { text: string; color: "error" | "muted" | "warning" };
	/** Muted parenthesized meta segments, joined with `·`. */
	meta?: string[];
}

/** Render the status icon for a card. */
function renderIcon(icon: CardIcon, theme: Theme): string {
	return theme.fg(icon.color, icon.glyph);
}

/** Bold name + quoted sanitized title (`Agent "task"`, `web_search "q"`).
 *  Title is not width-capped — the Text renderer wraps long headers
 *  (bash-style full display); safeTitle still flattens newlines/quotes. */
function renderNameTitle(name: string, title: string | undefined, theme: Theme): string {
	const bold = theme.fg("toolTitle", theme.bold(name));
	return title ? `${bold} ${theme.fg("bashMode", `"${safeTitle(title)}"`)}` : bold;
}

/** One header row for a tool card / notification / status line. */
export function renderHeader(header: CardHeader, theme: Theme): string {
	const marker = renderIcon(header.icon, theme);
	let tail = "";
	if (header.tail) {
		tail = ` ${theme.fg(header.tail.color, header.tail.text)}`;
	}
	const meta = header.meta?.length ? theme.fg("muted", ` (${header.meta.join(" \u00b7 ")})`) : "";
	const titlePart = header.name ? renderNameTitle(header.name, header.title, theme) : (header.title ?? "");
	return `${marker} ${titlePart}${tail}${meta}`;
}

// ── Content folding (shared card-body fold behavior) ─────────────

/** Number of visual lines shown before the fold hint (bash tail). */
const PREVIEW_LINES = 5;
/** Head preview lines for write-like tools (read 10). */
const PREVIEW_HEAD_LINES = 10;

// Cache for the folded preview — body (50k web_fetch) + width → truncated lines.
// Key is length + head/tail fingerprint (not reference), so a new details object
// with identical content still hits. Bounded to avoid unbounded growth.
const PREVIEW_CACHE = new Map<string, ReturnType<typeof truncateToVisualLines>>();
const PREVIEW_CACHE_MAX = 128;
function previewKey(body: string, w: number): string {
	return `${w}:${body.length}:${body.slice(0, 32)}\u0000${body.slice(-32)}`;
}

/** One content line with zero padding — pi's Text defaults to padding (1,1),
 * which adds stray blank rows around card content. All card surfaces must
 * use this (or contentRow) instead of bare `new Text(...)`. */
export function textLine(text: string): Component {
	return new Text(text, 0, 0);
}

export type BodyComponent = Text | Container | { invalidate: () => void; render: (w: number) => string[] };

/**
 * One body row: blank line + styled content (`\n` + styled — bash parity:
 * the bash card draws a blank row between header and output; a bare Text
 * without the leading `\n` would render adjacent to the header).
 */
export function contentRow(styled: string, x = 0): Component {
	return new Text(`\n${styled}`, x, 0);
}

/**
 * Card content block with uniform folding: short content renders in full
 * (blank line + content); content past PREVIEW_LINES folds to a tail preview
 * with the expand hint (Ctrl+O to expand reveals everything — folding never
 * loses content, it only caps how much fills the screen). Shared by every
 * card body so the fold behavior is identical across surfaces.
 */
function foldedBlock(styledRows: string[], theme: Theme, expanded = false): BodyComponent {
	return foldedBlockWith(styledRows, theme, expanded, "tail", PREVIEW_LINES);
}

function foldedBlockHead(styledRows: string[], theme: Theme, expanded = false): BodyComponent {
	return foldedBlockWith(styledRows, theme, expanded, "head", PREVIEW_HEAD_LINES);
}

function foldedBlockWith(
	styledRows: string[],
	theme: Theme,
	expanded: boolean,
	dir: "head" | "tail",
	lines: number,
): BodyComponent {
	if (expanded) {
		// Full render — every row, no fold. Content is never dropped in either
		// mode; expanded just stops capping what fills the screen.
		return { invalidate: () => {}, render: () => ["", ...styledRows] };
	}
	const body = styledRows.join("\n");
	return {
		invalidate: () => {},
		render: (w: number) => {
			const cacheKey = `${dir}:${previewKey(body, w)}`;
			let preview = PREVIEW_CACHE.get(cacheKey);
			if (!preview) {
				if (dir === "tail") {
					preview = truncateToVisualLines(body, lines, w, 0);
				} else {
					// head preview: keep first N visual lines, hint shows remaining
					const all = body.split("\n");
					const visual = truncateToVisualLines(body, 100000, w, 0);
					const totalVisual = visual.visualLines.length;
					if (totalVisual <= lines) {
						preview = { visualLines: visual.visualLines, skippedCount: 0 } as ReturnType<typeof truncateToVisualLines>;
					} else {
						const headBody = all.slice(0, lines).join("\n");
						const headPreview = truncateToVisualLines(headBody, lines, w, 0);
						preview = {
							visualLines: headPreview.visualLines,
							skippedCount: totalVisual - headPreview.visualLines.length,
						} as ReturnType<typeof truncateToVisualLines>;
					}
				}
				if (PREVIEW_CACHE.size >= PREVIEW_CACHE_MAX) {
					const first = PREVIEW_CACHE.keys().next().value as string | undefined;
					if (first !== undefined) PREVIEW_CACHE.delete(first);
				}
				PREVIEW_CACHE.set(cacheKey, preview);
			}
			if (preview.skippedCount === 0) return ["", ...preview.visualLines];
			const hint =
				dir === "head"
					? `${theme.fg("muted", `... (${preview.skippedCount} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
					: `${theme.fg("muted", `... (${preview.skippedCount} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			return ["", truncateToWidth(hint, w, "..."), ...preview.visualLines];
		},
	};
}

/** foldedBlock over a single colored string (split per line so colors survive folding). */
function foldedContent(styled: string, color: (line: string) => string, theme: Theme): BodyComponent {
	return foldedBlock(styled.split("\n").map(color), theme);
}

/**
 * Content block that honors the expanded flag: collapsed uses the uniform
 * fold (tail preview + expand hint); expanded renders every line in full.
 * Content is never dropped in either mode.
 */
function contentBlock(styled: string, color: (line: string) => string, expanded: boolean, theme: Theme): BodyComponent {
	if (expanded) {
		const lines = styled.split("\n");
		const cmp = new Container();
		cmp.addChild(contentRow(color(lines[0])));
		for (const line of lines.slice(1)) cmp.addChild(new Text(color(line), 0, 0));
		return cmp;
	}
	return foldedContent(styled, color, theme);
}

// ── Card assembly (folding built in) ─────────────────────────────

export interface CardBody {
	/** Failure reason — dim folded block, rendered after extra (above a message body). */
	error?: string;
	/** Plain content line — folded block (toolOutput color). */
	message?: string;
	/** Extra body components appended first (e.g. activity streams). */
	extra?: BodyComponent[];
}

export interface CardConfig {
	header?: CardHeader;
	body?: CardBody;
	/** Pre-formatted footer string. */
	footer?: string;
	expanded: boolean;
}

/** Unified card content (no background): header + body + footer. */
function cardContent(theme: Theme, sections: { header?: string; body?: BodyComponent[]; footer?: string }): Component {
	const cmp = new Container();
	if (sections.header) cmp.addChild(new Text(sections.header, 0, 0));
	for (const part of sections.body ?? []) cmp.addChild(part);
	if (sections.footer) cmp.addChild(contentRow(theme.fg("muted", sections.footer)));
	return cmp;
}

/**
 * Assemble a full card (no background shell): header row + body with the
 * fold behavior built in — error/message render as folded blocks (tail
 * preview + expand hint when long; full when `expanded`). Tool results
 * return this directly; the framework's default-shell Box paints the
 * background.
 */
export function renderCard(config: CardConfig, theme: Theme): Component {
	const sections: { header?: string; body?: BodyComponent[]; footer?: string } = {};
	if (config.header) sections.header = renderHeader(config.header, theme);

	const bodyParts: BodyComponent[] = [];
	const b = config.body;
	if (b) {
		// extra (activity streams etc.) first, then failure reason, then message.
		if (b.extra?.length) bodyParts.push(...b.extra);
		if (b.error) bodyParts.push(contentBlock(b.error, (l) => theme.fg("dim", l), config.expanded, theme));
		if (b.message) bodyParts.push(contentBlock(b.message, (l) => theme.fg("toolOutput", l), config.expanded, theme));
	}
	if (bodyParts.length) sections.body = bodyParts;
	if (config.footer) sections.footer = config.footer;

	return cardContent(theme, sections);
}

/** Background shell (Box 1,1) for surfaces rendering outside the tool shell. */
export function cardShell(
	theme: Theme,
	bg: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg",
	...children: BodyComponent[]
): Box {
	const cmp = new Box(1, 1, (t: string) => theme.bg(bg, t));
	for (const child of children) cmp.addChild(child);
	return cmp;
}

type RowStyle = "thinking" | "tool" | "text" | "muted";

/** One styled content row (activity lines, widget rows). */
export interface StyledRow {
	style: RowStyle;
	content: string;
}

/** Render one styled row (thinking italic gray, tool toolTitle, text plain, muted dim). */
export function styleRow(row: StyledRow, theme: Theme): string {
	switch (row.style) {
		case "thinking":
			return theme.italic(theme.fg("thinkingText", row.content));
		case "tool":
			return theme.fg("toolTitle", row.content);
		case "muted":
			return theme.fg("muted", row.content);
		default:
			return row.content;
	}
}

// ── Data-driven card (consumers pass data, component handles everything) ─

/** Data-only card config: pass text, the card assembles header + folded body. */
type CardStatus = "processing" | "success" | "error" | "stop";

interface DataCardConfig {
	/** Semantic state — drives the icon (spinner/✓/✗/■) and tail color. */
	status: CardStatus;
	/** Bold tool/task name (`web_search`, `Agent`). */
	name: string;
	/** Quoted title (query, url, task) — always visible. */
	title?: string;
	/** Status slot — free text (starting…, start failed…); color follows status. */
	tail?: string;
	/** Muted parenthesized meta (channel echo, counts). */
	meta?: string[];
	/** Body — plain text or styled rows; folded automatically. */
	body?: string | StyledRow[];
	/** Preview direction: tail (bash, default) or head (write-like). */
	preview?: "head" | "tail";
	/** Pre-formatted footer line (muted) — session paths, file links. */
	footer?: string;
	/** Error block below the body — dim folded. */
	error?: string;
	expanded: boolean;
	/**
	 * Bare card (no header row): body only. The framework renders the call's
	 * header line and the result side by side while a tool streams, so a
	 * streaming result must not repeat the header.
	 */
	bare?: boolean;
}

/** Map status → card icon (library decision; consumers pass status only). */
export function iconForStatus(status: CardStatus, spinner?: Spinner): CardIcon {
	switch (status) {
		case "processing":
			return { glyph: (spinner ?? new Spinner()).current(), color: "accent" };
		case "error":
			return { glyph: "\u2717", color: "error" };
		case "stop":
			return { glyph: "\u25a0", color: "warning" };
		default:
			return { glyph: "\u2713", color: "success" };
	}
}

/**
 * One data-driven card: consumers pass text fields + a status; the component
 * derives the icon and tail color from status and folds the body (long
 * content gets a tail preview + expand hint, full when expanded).
 */
export function dataCard(config: DataCardConfig, theme: Theme, spinner?: Spinner): Component {
	return renderCard(
		{
			header: config.bare
				? undefined
				: {
						icon: iconForStatus(config.status, spinner),
						name: config.name,
						title: config.title,
						tail: config.tail ? { text: config.tail, color: config.status === "error" ? "error" : "muted" } : undefined,
						meta: config.meta,
					},
			body:
				config.body || config.error
					? typeof config.body === "string"
						? config.preview === "head"
							? {
									extra: [
										foldedBlockHead(
											config.body.split("\n").map((l) => theme.fg("toolOutput", l)),
											theme,
											config.expanded,
										),
									],
									error: config.error,
								}
							: { message: config.body, error: config.error }
						: {
								extra: (config.body as StyledRow[]).length
									? [
											(config.preview === "head" ? foldedBlockHead : foldedBlock)(
												(config.body as StyledRow[]).map((r) => styleRow(r, theme)),
												theme,
												config.expanded,
											),
										]
									: undefined,
								error: config.error,
							}
					: undefined,
			expanded: config.expanded,
			footer: config.footer,
		},
		theme,
	);
}
