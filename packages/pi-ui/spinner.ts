/**
 * pi-ui — shared formatting primitives for pi extension UI.
 *
 * Spinner (wall-clock driven frames), duration formatting, text clipping
 * and title sanitization — used by tool cards, widgets and notification
 * surfaces across extensions.
 */

/** Spinner frame interval (80ms — matches Pi's native loader cadence). */
const SPINNER_TICK_MS = 80;

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

/** Collapse whitespace, trim, and cut long tails to `max` chars (ellipsis prefix). */
export function clipTail(s: string, max = 60): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `\u2026${clean.slice(clean.length - max + 1)}`;
}

/**
 * Task title, rendered safe for a single quoted line: tabs/newlines are
 * flattened and embedded double quotes neutralized (so quotes around the
 * title can't be broken), then capped with a trailing ellipsis.
 */
export function safeTitle(title: string | undefined, max = 40): string {
	const flat = (title ?? "(untitled)")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/"/g, "'")
		.trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}\u2026`;
}
