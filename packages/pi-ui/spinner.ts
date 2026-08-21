/**
 * pi-ui — shared formatting primitives for pi extension UI.
 *
 * Spinner (wall-clock driven frames), duration formatting, text clipping
 * and title sanitization — used by tool cards, widgets and notification
 * surfaces across extensions.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** Spinner frame interval (80ms — matches Pi's native loader cadence).
 * Single source for animation cadence: the ticker and every animated
 * component subscribe with this — no magic numbers elsewhere. */
export const SPINNER_TICK_MS = 80;

/** Spinner frames (one Braille frame per tick). */
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

/**
 * Spinner animation driven by wall-clock time: `current()` derives the frame
 * from time elapsed since construction, so the cadence stays a steady 80ms no
 * matter how often the UI re-renders.
 */
export class Spinner {
	private readonly startedAt = Date.now();
	current(): string {
		return SPINNER[Math.floor((Date.now() - this.startedAt) / SPINNER_TICK_MS) % SPINNER.length];
	}
}

/** Seconds with one decimal — shared by cards, widgets and headers. */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Duration meta shared by tool views: a live `Elapsed` while running (wall
 * clock, updates every frame), a fixed `Took` once complete. Pass the task's
 * startedAt (the call seeds it into the render state at execution start).
 */
export function durationMeta(
	status: "processing" | "success" | "error" | "stop",
	startedAt?: number,
	endedAt?: number,
): string | undefined {
	if (startedAt == null) return undefined;
	if (status === "processing") return `Elapsed ${formatDuration(Date.now() - startedAt)}`;
	return `Took ${formatDuration((endedAt ?? Date.now()) - startedAt)}`;
}

/** Collapse whitespace, trim, and cut long tails to `max` terminal columns (ellipsis prefix). */
export function clipTail(s: string, max = 60): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (visibleWidth(clean) <= max) return clean;
	// Keep the tail (latest content) within `max - 1` columns, prefixed with …
	const chars = [...clean];
	let w = 0;
	let tail = "";
	for (let i = chars.length - 1; i >= 0; i--) {
		const cw = visibleWidth(chars[i]);
		if (w + cw > max - 1) break;
		tail = chars[i] + tail;
		w += cw;
	}
	return `\u2026${tail}`;
}

/**
 * Task title, rendered safe for a single quoted line: tabs/newlines are
 * flattened and embedded double quotes neutralized (so quotes around the
 * title can't be broken). Pass `max` to also cap the width with a trailing
 * ellipsis (single-line contexts without a wrap fallback); omit it where the
 * renderer wraps long lines (card headers — bash-style full display).
 */
export function safeTitle(title: string | undefined, max?: number): string {
	const flat = (title ?? "(untitled)")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/"/g, "'")
		.trim();
	if (max === undefined || visibleWidth(flat) <= max) return flat;
	// Head within `max - 1` columns, trailing ellipsis. Plain output (no ANSI)
	// so callers can wrap it in their own theme colors.
	let w = 0;
	let head = "";
	for (const ch of flat) {
		const cw = visibleWidth(ch);
		if (w + cw > max - 1) break;
		head += ch;
		w += cw;
	}
	return `${head}\u2026`;
}
