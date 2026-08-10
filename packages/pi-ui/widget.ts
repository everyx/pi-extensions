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
import { formatDuration, Spinner, safeTitle } from "./spinner.js";

const WIDGET_KEY = "pi-ui-status";
const TICK_MS = 500;
const EXCERPT_INDENT = "    ";

export type WidgetStatus = "running" | "stopped" | "done" | "failed";

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
 *   add(item)  — start tracking (registers the widget lazily)
 *   remove(id) — stop tracking
 *   dispose()  — clear everything (session shutdown)
 */
export class StatusWidget {
	private readonly ui: ExtensionUIContext;
	private readonly rows = new Map<string, { item: WidgetItem; spinner: Spinner }>();
	private interval: ReturnType<typeof setInterval> | undefined;
	private registered = false;
	private tui: { requestRender(): void } | undefined;

	constructor(
		ui: ExtensionUIContext,
		/** Optional widget title line (e.g. "Agents") — renders above the rows. */
		private readonly title?: string,
	) {
		this.ui = ui;
	}

	add(item: WidgetItem): void {
		if (this.rows.has(item.id)) return;
		this.rows.set(item.id, { item, spinner: new Spinner() });
		this.ensureRunning();
	}

	remove(id: string): void {
		if (this.rows.delete(id) && this.rows.size === 0) {
			this.dispose();
			return;
		}
		this.tui?.requestRender();
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		this.rows.clear();
		if (this.registered) {
			this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
		}
		this.tui = undefined;
	}

	// ── Internal ───────────────────────────────────────────

	private ensureRunning(): void {
		if (this.interval) return;
		this.registerWidget();
		this.interval = setInterval(() => this.tick(), TICK_MS);
	}

	private tick(): void {
		for (const [id, row] of this.rows) {
			if (row.item.status !== "running") this.rows.delete(id);
		}
		if (this.rows.size === 0) {
			this.dispose();
			return;
		}
		this.tui?.requestRender();
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
			// One marker line: `● <Title>` — accent dot + bold title color, so
			// the widget's purpose is obvious at a glance (v1.2.0 style).
			lines.push(`${theme.fg("accent", "\u25cf")} ${theme.fg("toolTitle", theme.bold(this.title))}`);
		}
		for (const row of this.rows.values()) {
			lines.push(...renderWidgetItemLine(row.item, theme, row.spinner));
		}
		return lines;
	}
}
