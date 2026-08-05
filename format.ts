/**
 * pi-subagent — shared formatting utilities.
 *
 * Pure string-formatting and display helpers used by the TUI rendering
 * layer (render.ts), the status widget (widget.ts), and the tool glue
 * (index.ts). Separated from render.ts so non-rendering modules don't
 * need to depend on the rendering module for string utilities.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentActivity } from "./agent-process.js";

/** Spinner frames (80ms tick — matches Pi's native loader interval). */
export const SPINNER = [
	"\u280b",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283c",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280f",
];

/** Spinner animation: owns the frame index, ticks forward on each interval. */
export class Spinner {
	private frame = 0;
	tick() {
		this.frame++;
	}
	current(): string {
		return SPINNER[this.frame % SPINNER.length];
	}
}

/** Seconds with one decimal — shared by cards and the Agents widget. */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Activity excerpt length cap; long tails get a leading ellipsis. */
const ACTIVITY_EXCERPT_MAX = 60;

/** Collapse whitespace, trim, and cut long tails to `max` chars (ellipsis prefix). */
export function clipTail(s: string, max: number = ACTIVITY_EXCERPT_MAX): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `\u2026${clean.slice(clean.length - max + 1)}`;
}

/**
 * One activity row: "Thinking..." (pi hidden-thinking style), a tool call
 * (toolTitle name + ": " + muted args), or muted text. Shared by the tool
 * card activity row and the Agents widget — single source of truth so the
 * two surfaces can never drift apart. Pass `max` to truncate long tails
 * (widget); the card passes none and shows the full text.
 */
export function activityRow(activity: AgentActivity, theme: Theme, max?: number): string {
	if (activity.kind === "thinking") {
		return theme.italic(theme.fg("thinkingText", "Thinking..."));
	}
	if (activity.kind === "tool") {
		const args = max === undefined ? activity.args : clipTail(activity.args, max);
		return args
			? `${theme.fg("toolTitle", activity.name)}: ${theme.fg("muted", args)}`
			: theme.fg("toolTitle", activity.name);
	}
	return theme.fg("muted", max === undefined ? activity.text : clipTail(activity.text, max));
}

/**
 * Task title, rendered safe for a single quoted line: tabs/newlines are
 * flattened and embedded double quotes neutralized (so the bashMode quotes
 * around the title can't be broken), then capped with a trailing ellipsis.
 * Shared by status lines, headers, the notification card and the widget.
 */
export function safeTitle(title: string | undefined, max = 40): string {
	const flat = (title ?? "(untitled)")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/"/g, "'")
		.trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}\u2026`;
}
