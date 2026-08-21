/**
 * Width safety — the single exit for pi-ui's self-rendered rows.
 *
 * pi crashes on any rendered line wider than the terminal (visibleWidth is
 * its crash metric), and newlines collapse to zero width — so flattening,
 * capping and alignment live here, single-pointed. Callers decide what the
 * content is and whether it may wrap (multi-line content belongs in Text
 * components, which wrap); a structRow is one physical line that always fits.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { clipTail } from "./spinner.js";

/** Cut plain text to `max` columns keeping the head, trailing ellipsis. */
export function capPlain(s: string, max: number): string {
	if (visibleWidth(s) <= max) return s;
	let w = 0;
	let head = "";
	for (const ch of s) {
		const cw = visibleWidth(ch);
		if (w + cw > max - 1) break;
		head += ch;
		w += cw;
	}
	return `${head}\u2026`;
}

/**
 * One structural row that always fits `width`:
 *
 *   [prefix] content [suffix]
 *
 * - `prefix` fixes the alignment (styled OK; visibleWidth skips ANSI).
 * - `content` is plain text — flattened and capped to exactly what's left,
 *   zero safety margin (same metric as pi's crash check).
 * - `suffix` is right-side text that must stay visible (live meta), styled OK.
 *
 * Which end of over-long content to sacrifice is the caller's call:
 * "head" (default) keeps the beginning (titles); "tail" keeps the latest
 * (activity streams, pi-bash style).
 */
export function structRow(opts: {
	prefix: string;
	content: string;
	suffix?: string;
	width: number;
	keep?: "head" | "tail";
	styleContent?: (capped: string) => string;
}): string {
	const flat = opts.content.replace(/[\r\n\t]+/g, " ").trim();
	const avail = Math.max(0, opts.width - visibleWidth(opts.prefix) - visibleWidth(opts.suffix ?? ""));
	const capped = opts.keep === "tail" ? clipTail(flat, avail) : capPlain(flat, avail);
	return `${opts.prefix}${opts.styleContent ? opts.styleContent(capped) : capped}${opts.suffix ?? ""}`;
}
