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
import { formatDuration, SPINNER_TICK_MS, Spinner, safeTitle } from "./spinner.js";
import { type TickerHandle, ticker } from "./ticker.js";

const WIDGET_KEY = "pi-ui-status";
const EXCERPT_INDENT = "    ";

export type WidgetStatus = "running" | "stopped" | "done" | "failed";

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
	render(): string[];
	invalidate(): void;
}

/** Render one item's status line + activity rows (colors live here). */
export function renderWidgetItemLine(item: WidgetItem, theme: Theme, spinner: Spinner): string[] {
	const elapsed = formatDuration(Date.now() - item.startedAt);
	const label = safeTitle(item.title, 40);

	let status: string;
	if (item.status === "running") {
		status = theme.fg("accent", spinner.current());
	} else if (item.status === "failed") {
		status = theme.fg("error", "\u2717");
	} else if (item.status === "stopped") {
		status = theme.fg("warning", "\u25a0");
	} else {
		status = theme.fg("success", "\u2713");
	}

	const line = ` ${status} ${theme.fg("bashMode", label)} ${theme.fg("muted", `(${elapsed})`)}`;
	const rows = (item.rows ?? []).map((r) => `${EXCERPT_INDENT}${styleRow(r, theme)}`);
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
	) {
		this.ui = ui;
	}

	add(item: WidgetItem): void {
		if (this.rows.has(item.id)) return;
		this.total++;
		this.rows.set(item.id, { item, spinner: new Spinner() });
		this.ensureRunning();
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
			if (row.item.status !== "running") {
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

	/** Lifetime progress meta: `1/3` or `(1+2)/3` (abnormal count in error). */
	private metaLine(theme: Theme): string {
		if (this.total === 0) return "";
		const abnormal = this.failed + this.stopped;
		const numerator = abnormal > 0 ? `(${this.done}+${theme.fg("error", String(abnormal))})` : String(this.done);
		return ` ${theme.fg("muted", `${numerator}/${this.total}`)}`;
	}

	private registerWidget(): void {
		if (this.registered) return;
		this.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui as { requestRender(): void };
				return {
					render: () => this.render(theme),
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

	private render(theme: Theme): string[] {
		const lines: string[] = [];
		if (this.title) {
			// One marker line: ` ● <Title>` — 1-char left padding (matching the
			// agent rows), accent dot + bold title color (v1.2.0 style).
			lines.push(
				` ${theme.fg("accent", "\u25cf")} ${theme.fg("toolTitle", theme.bold(this.title))}${this.metaLine(theme)}`,
			);
		}
		for (const row of this.rows.values()) {
			lines.push(...renderWidgetItemLine(row.item, theme, row.spinner));
		}
		return lines;
	}
}
