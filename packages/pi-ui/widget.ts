/**
 * pi-ui — StatusWidget: a foreground indicator for background work.
 *
 * Data-driven: consumers add pure-data items (id/title/status/rows); the
 * widget renders everything (spinner, elapsed, row styling). No render
 * functions cross the API — like the card view layer, status drives the
 * icon and colors.
 *
 * Rows use the same "activity line" style vocabulary as the card body
 * (thinking/tool/text) so one model renders on both surfaces.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { clipTail, formatDuration, SPINNER_TICK_MS, Spinner, safeTitle } from "./spinner.js";
import { type TickerHandle, ticker } from "./ticker.js";

const WIDGET_KEY = "pi-ui-status";
// 3 columns: ` ⠋ ` — content aligns with the @name title start (1 + glyph 1 + space).
export const EXCERPT_INDENT = "   ";

export type WidgetStatus = "running" | "idle" | "stopped" | "done" | "failed";

/** How a tracked item ended — feeds the lifetime progress meta (`1/3`). */
export type WidgetResult = "done" | "failed" | "stopped";

/** Map a terminal widget status to the result it implies (tick cleanup). */
function statusToResult(status: WidgetStatus): WidgetResult | undefined {
	if (status === "done") return "done";
	if (status === "failed") return "failed";
	if (status === "stopped") return "stopped";
	return undefined;
}

/** One activity line in the widget (same style vocabulary as card rows). */
export interface WidgetRow {
	style: "thinking" | "tool" | "text";
	content: string;
}

/** Pure data for one widget row — consumers never touch theme/colors. */
export interface WidgetItem {
	id: string;
	title: string;
	startedAt: number;
	status: WidgetStatus;
	/** Latest activity rows (structured, not pre-formatted). */
	rows?: WidgetRow[];
}

interface WidgetRender {
	render(width: number): string[];
	invalidate(): void;
}

/** Render one item's status line + activity rows (colors live here).
 *  `width` is the terminal width pi passes at render time — activity rows are
 *  clipped to exactly `width - indent` (no safety margin: visibleWidth is the
 *  same metric pi's over-wide crash check uses), so wide terminals show more
 *  of the tail and narrow ones stay bounded. */
export function renderWidgetItemLine(item: WidgetItem, theme: Theme, spinner: Spinner, width = 80): string[] {
	const label = safeTitle(item.title, 40);

	let status: string;
	let meta: string;
	if (item.status === "running") {
		status = theme.fg("accent", spinner.current());
		meta = `(${formatDuration(Date.now() - item.startedAt)})`;
	} else if (item.status === "failed") {
		status = theme.fg("error", "\u2717");
		meta = "(failed)";
	} else if (item.status === "stopped") {
		status = theme.fg("warning", "\u25a0");
		meta = "(stopped)";
	} else if (item.status === "idle") {
		// Resident persistent agent: double-vertical-bar pause marker, no meta —
		// the icon carries the state (zero-token wait). Unframed, so it reads
		// uniformly with the other status glyphs (⠋✓✗■).
		status = theme.fg("muted", "\u2016");
		meta = "";
	} else {
		status = theme.fg("success", "\u2713");
		meta = "(done)";
	}

	const line = ` ${status} ${theme.fg("bashMode", label)} ${theme.fg("muted", meta)}`;
	// Clip the *plain* text to width first, then style — truncating after
	// styling could cut an ANSI sequence in half. Tail-keeping (clipTail)
	// preserves the latest content, pi-bash style.
	const rows = (item.rows ?? []).map((r) => {
		// Exact: EXCERPT_INDENT (3) + clipped content ≤ width. visibleWidth is
		// the same metric pi's over-wide crash check uses (grapheme-aware), so
		// a row ≤ width here can never trip it. Zero safety margin needed.
		const max = Math.max(0, width - EXCERPT_INDENT.length);
		const clipped = clipTail(r.content, max);
		return `${EXCERPT_INDENT}${styleRow({ ...r, content: clipped }, theme)}`;
	});
	return [line, ...rows];
}

function styleRow(row: WidgetRow, theme: Theme): string {
	switch (row.style) {
		case "thinking":
			return theme.italic(theme.fg("thinkingText", row.content));
		case "tool":
			return theme.fg("toolTitle", row.content);
		default:
			return theme.fg("muted", row.content);
	}
}

/**
 * Foreground status widget for background tasks.
 *   add(item)        — start tracking (registers the widget lazily)
 *   remove(id, res?) — stop tracking; `res` feeds the lifetime progress meta
 *   dispose()        — clear everything (session shutdown)
 *
 * Lifetime progress: while the widget is alive it counts every tracked item
 * (`total`) and how each ended (`done`/`failed`/`stopped`), rendered after
 * the title as `1/3` — or `(1+2)/3` once any item ended abnormally (the
 * abnormal count is colored error; the parentheses are the math convention
 * for a polynomial numerator). A remove() without a result is not counted.
 */
export class StatusWidget {
	private readonly ui: ExtensionUIContext;
	private readonly rows = new Map<string, { item: WidgetItem; spinner: Spinner }>();
	private animation: TickerHandle | undefined;
	private registered = false;
	private tui: { requestRender(): void } | undefined;
	private total = 0;
	private done = 0;
	private failed = 0;
	private stopped = 0;

	constructor(
		ui: ExtensionUIContext,
		/** Optional widget title line (e.g. "Agents") — renders above the rows. */
		private readonly title?: string,
		/** Max rows before swarm-mode collapse (running/failed first, rest folded). */
		private readonly maxLines = 8,
	) {
		this.ui = ui;
	}

	add(item: WidgetItem): void {
		if (this.rows.has(item.id)) return;
		this.total++;
		this.rows.set(item.id, { item, spinner: new Spinner() });
		this.ensureRunning();
	}

	/**
	 * Update one row's status in place (e.g. idle ⇄ running for a persistent
	 * agent woken by a message) without changing the lifetime counters.
	 */
	updateStatus(id: string, status: WidgetStatus): void {
		const row = this.rows.get(id);
		if (!row) return;
		row.item = { ...row.item, status };
		this.tui?.requestRender();
	}

	/** Update one row's activity excerpt in place (live working output). */
	updateRows(id: string, rows: WidgetRow[]): void {
		const row = this.rows.get(id);
		if (!row) return;
		row.item = { ...row.item, rows };
		this.tui?.requestRender();
	}

	remove(id: string, result?: WidgetResult): void {
		if (!this.rows.delete(id)) return;
		this.countResult(result);
		if (this.rows.size === 0) {
			this.dispose();
			return;
		}
		this.tui?.requestRender();
	}

	dispose(): void {
		if (this.animation) {
			this.animation.unsubscribe();
			this.animation = undefined;
		}
		this.rows.clear();
		// An empty widget ends its lifetime — the progress meta starts fresh
		// on the next tracked batch (counters are per widget-lifetime, not
		// per extension session).
		this.total = 0;
		this.done = 0;
		this.failed = 0;
		this.stopped = 0;
		if (this.registered) {
			this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
		}
		this.tui = undefined;
	}

	// ── Internal ───────────────────────────────────────────

	private ensureRunning(): void {
		if (this.animation) return;
		this.registerWidget();
		// One shared clock for all animated surfaces: redraws run at the
		// spinner cadence via the unified ticker, not a widget-local timer.
		this.animation = ticker.subscribe(() => this.tick(), SPINNER_TICK_MS);
	}

	private tick(): void {
		for (const [id, row] of this.rows) {
			// Terminal statuses end the row's lifetime (folded into the counters).
			// idle rows stay — a persistent agent remains addressable until stopped.
			if (row.item.status === "done" || row.item.status === "failed" || row.item.status === "stopped") {
				this.rows.delete(id);
				this.countResult(statusToResult(row.item.status));
			}
		}
		if (this.rows.size === 0) {
			this.dispose();
			return;
		}
		this.tui?.requestRender();
	}

	/** Fold an ended item's status into the lifetime counters. */
	private countResult(result: WidgetResult | undefined): void {
		if (result === "done") this.done++;
		else if (result === "failed") this.failed++;
		else if (result === "stopped") this.stopped++;
	}

	/**
	 * Lifetime meta, aligned with the card-header meta vocabulary: an outer
	 * paren group, dot-separated. `done n/total` is the progress; live segments
	 * (running / idle) are counted from the rows, abnormal ends (failed,
	 * stopped) are accumulated counters with failed colored error.
	 */
	private metaLine(theme: Theme): string {
		if (this.total === 0) return "";
		const running = [...this.rows.values()].filter((r) => r.item.status === "running").length;
		const idle = [...this.rows.values()].filter((r) => r.item.status === "idle").length;
		const parts: string[] = [`done ${this.done}/${this.total}`];
		if (running) parts.push(`${running} running`);
		if (idle) parts.push(`${idle} idle`);
		if (this.failed) parts.push(theme.fg("error", `${this.failed} failed`));
		if (this.stopped) parts.push(`${this.stopped} stopped`);
		return ` ${theme.fg("muted", `(${parts.join(" · ")})`)}`;
	}

	private registerWidget(): void {
		if (this.registered) return;
		this.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui as { requestRender(): void };
				return {
					render: (width: number) => this.render(theme, width),
					invalidate: () => {
						this.registered = false;
						this.tui = undefined;
					},
				} satisfies WidgetRender;
			},
			{ placement: "aboveEditor" },
		);
		this.registered = true;
	}

	private render(theme: Theme, width?: number): string[] {
		const lines: string[] = [];
		if (this.title) {
			// One marker line: ` ● <Title>` — 1-char left padding (matching the
			// agent rows), accent dot + bold title color (v1.2.0 style).
			lines.push(
				` ${theme.fg("accent", "\u25cf")} ${theme.fg("toolTitle", theme.bold(this.title))}${this.metaLine(theme)}`,
			);
		}
		const rows = [...this.rows.values()];
		if (rows.length > this.maxLines) {
			// Swarm mode: show the live (running) and abnormal (failed) rows
			// first, fold the rest into a counter line — a glance must answer
			// "how many are working / did any fail" without scrolling.
			const priority = (s: WidgetStatus) =>
				s === "running" ? 0 : s === "failed" ? 1 : s === "stopped" ? 2 : s === "idle" ? 3 : 4;
			const sorted = [...rows].sort((a, b) => priority(a.item.status) - priority(b.item.status));
			for (const row of sorted.slice(0, this.maxLines)) {
				lines.push(...renderWidgetItemLine(row.item, theme, row.spinner, width));
			}
			const rest = sorted.slice(this.maxLines);
			const restRunning = rest.filter((r) => r.item.status === "running").length;
			const restFailed = rest.filter((r) => r.item.status === "failed").length;
			const restIdle = rest.filter((r) => r.item.status === "idle").length;
			const restParts: string[] = [`+${rest.length} more`];
			if (restRunning) restParts.push(`${restRunning} running`);
			if (restFailed) restParts.push(theme.fg("error", `${restFailed} failed`));
			if (restIdle) restParts.push(`${restIdle} idle`);
			lines.push(` ${theme.fg("muted", `\u2026 ${restParts.join(" · ")}`)}`);
		} else {
			for (const row of rows) {
				lines.push(...renderWidgetItemLine(row.item, theme, row.spinner, width));
			}
		}
		return lines;
	}
}
