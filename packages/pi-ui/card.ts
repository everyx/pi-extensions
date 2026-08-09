/**
 * pi-ui — shared card-header rendering.
 *
 * One header row: `[marker] <name> "title" <state word / status> (<meta>)`.
 * The marker is a status icon (accent spinner / ✓ / ✗ / ■); the quoted title
 * uses bashMode like the bash card's `$ cmd`; the name keeps toolTitle bold.
 * The state is a natural-language verb phrase joined with a plain space —
 * `·` is reserved for data separators (widget elapsed time, meta).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
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
