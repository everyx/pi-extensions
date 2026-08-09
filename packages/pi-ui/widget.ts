/**
 * pi-ui — StatusWidget: a foreground indicator for background work.
 *
 * Generic "running tasks" widget (subagent's Agents widget generalized):
 * tracks a set of items, renders one line each (`⠋ "title" (12.3s)` plus an
 * optional activity excerpt), ticks a wall-clock spinner, and drops items
 * once they report inactive. Any extension with background work that needs
 * a foreground indicator can use it.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, Spinner, safeTitle } from "./spinner.js";

const WIDGET_KEY = "pi-ui-status";
const TICK_MS = 500;
const EXCERPT_INDENT = "    ";

/** One row in the widget: identity + how to render its line. */
export interface WidgetItem {
	id: string;
	title: string;
	startedAt: number;
	/** True while the work is still running; inactive rows are dropped. */
	isActive(): boolean;
	/** Latest-activity excerpt line, or null. Rendered below the status line. */
	excerpt?(theme: Theme): string | null;
}

interface WidgetRender {
	render(): string[];
	invalidate(): void;
}

/** Renders one item's status line + excerpt (shared with card activity rows). */
export function renderWidgetItemLine(item: WidgetItem, theme: Theme, spinner: Spinner): string[] {
	const elapsed = formatDuration(Date.now() - item.startedAt);
	const label = safeTitle(item.title, 40);
	const status = ` ${theme.fg("accent", spinner.current())} ${theme.fg("bashMode", label)} ${theme.fg("muted", `(${elapsed})`)}`;
	const excerpt = item.excerpt?.(theme);
	return excerpt ? [status, `${EXCERPT_INDENT}${excerpt}`] : [status];
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

	constructor(ui: ExtensionUIContext) {
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
			if (!row.item.isActive()) this.rows.delete(id);
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
						// Theme changed — force re-registration to capture the fresh theme.
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
		for (const row of this.rows.values()) {
			lines.push(...renderWidgetItemLine(row.item, theme, row.spinner));
		}
		return lines;
	}
}
