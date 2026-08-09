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

import { type Spinner, safeTitle } from "./spinner.js";

export type CardIcon =
	| { type: "spinner"; spinner: Spinner }
	| { type: "success" }
	| { type: "error" }
	| { type: "stopped" };

export interface CardHeader {
	icon: CardIcon;
	/** Raw title. When `name` is set, rendered as `name "title"` (bashMode quotes). */
	title?: string;
	/** Optional bold name prefix: `Agent "task"` — use when title is a raw label. */
	name?: string;
	/** Verb-state line: "<verb> <phase>" — "starting…" / "started" / "start failed". */
	state?: { verb: string; phase: "running" | "done" | "failed" };
	/** Plain colored status word: "failed" (error) / "stopped" (warning). */
	status?: { word: string; color: "error" | "warning" };
	/** Muted parenthesized meta segments, joined with `·`. */
	meta?: string[];
}

/** Render the status icon for a card. */
export function renderIcon(icon: CardIcon, theme: Theme): string {
	switch (icon.type) {
		case "spinner":
			return theme.fg("accent", icon.spinner.current());
		case "success":
			return theme.fg("success", "\u2713");
		case "error":
			return theme.fg("error", "\u2717");
		case "stopped":
			return theme.fg("warning", "\u25a0");
	}
}

/** Bold name + quoted sanitized title (`Agent "task"`, `web_search "q"`). */
export function renderNameTitle(name: string, title: string | undefined, theme: Theme): string {
	const bold = theme.fg("toolTitle", theme.bold(name));
	return title ? `${bold} ${theme.fg("bashMode", `"${safeTitle(title)}"`)}` : bold;
}

/** Double-consonant verb forms for the running phase (stop → stopping…). */
const RUNNING_WORDS: Record<string, string> = {
	start: "starting\u2026",
	stop: "stopping\u2026",
	steer: "steering\u2026",
	control: "controlling\u2026",
};

/** Past-tense forms with double consonants (stop → stopped). */
const DONE_WORDS: Record<string, string> = {
	start: "started",
	stop: "stopped",
	steer: "steered",
	control: "controlled",
};

function stateWord(verb: string, phase: "running" | "done" | "failed"): string {
	switch (phase) {
		case "running":
			return RUNNING_WORDS[verb] ?? `${verb}ing\u2026`;
		case "failed":
			return `${verb} failed`;
		default:
			return DONE_WORDS[verb] ?? `${verb}ed`;
	}
}

/** One header row for a tool card / notification / status line. */
export function renderHeader(header: CardHeader, theme: Theme): string {
	const marker = renderIcon(header.icon, theme);
	let tail = "";
	if (header.state) {
		const { verb, phase } = header.state;
		tail = ` ${theme.fg(phase === "failed" ? "error" : "muted", stateWord(verb, phase))}`;
	} else if (header.status) {
		tail = ` ${theme.fg(header.status.color, header.status.word)}`;
	}
	const meta = header.meta?.length ? theme.fg("muted", ` (${header.meta.join(" \u00b7 ")})`) : "";
	const titlePart = header.name ? renderNameTitle(header.name, header.title, theme) : (header.title ?? "");
	return `${marker} ${titlePart}${tail}${meta}`;
}

// ── Content folding (shared card-body fold behavior) ─────────────

/** Number of visual lines shown before the fold hint. */
export const PREVIEW_LINES = 5;

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
export function foldedBlock(styledRows: string[], theme: Theme): BodyComponent {
	const body = styledRows.join("\n");
	return {
		invalidate: () => {},
		render: (w: number) => {
			const preview = truncateToVisualLines(body, PREVIEW_LINES, w, 0);
			if (preview.skippedCount === 0) return ["", ...preview.visualLines];
			const hint = `${theme.fg("muted", `... (${preview.skippedCount} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			return ["", truncateToWidth(hint, w, "..."), ...preview.visualLines];
		},
	};
}

/** foldedBlock over a single colored string (split per line so colors survive folding). */
export function foldedContent(styled: string, color: (line: string) => string, theme: Theme): BodyComponent {
	return foldedBlock(styled.split("\n").map(color), theme);
}

/**
 * Content block that honors the expanded flag: collapsed uses the uniform
 * fold (tail preview + expand hint); expanded renders every line in full.
 * Content is never dropped in either mode.
 */
export function contentBlock(
	styled: string,
	color: (line: string) => string,
	expanded: boolean,
	theme: Theme,
): BodyComponent {
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
	/** Failure reason — dim folded block below the body. */
	error?: string;
	/** Plain content line — folded block (toolOutput color). */
	message?: string;
	/** Extra body components appended in order (e.g. activity streams). */
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
