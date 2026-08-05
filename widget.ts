/**
 * pi-subagent — AgentWidget.
 *
 * Persistent above-editor widget showing one status line per *background*
 * agent: `⠋ title (42.0s)`, plus a latest-activity excerpt line aligned
 * under the title (tool call / Thinking... / text tail). Foreground agents
 * are intentionally excluded — their live output already streams inline in
 * the tool card (mirrors tintinweb's default widget mode, which hides
 * foreground runs).
 *
 * Status-only by design: no full output stream, no navigation, no
 * conversation rendering. Full content arrives via the completion
 * notification and `pi --session <path>` review afterwards.
 *
 * Visual + animation follow pi's built-in working indicator (Loader):
 * same Braille frames, 80ms interval, accent spinner + muted message.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentProcess } from "./agent-process.js";
import { activityRow, formatDuration, Spinner, safeTitle } from "./format.js";

// A single Spinner class drives both the widget and the card animation — same
// frames, same 80ms cadence, same implementation (see format.ts).

const WIDGET_KEY = "subagents";
const TICK_MS = 80;

/** Widget line indent: 1 (widget padding) + ⠋ + space → excerpt aligns with the title. */
const EXCERPT_INDENT = "   ";

interface WidgetRender {
	render(): string[];
	invalidate(): void;
}

/**
 * One widget line: spinner + quoted title + elapsed time, plus the latest
 * activity excerpt — the per-agent child of AgentWidget (pi Loader-style:
 * owns its spinner, renders its own line).
 */
class AgentRow {
	readonly agent: AgentProcess;
	readonly spinner = new Spinner();

	constructor(agent: AgentProcess) {
		this.agent = agent;
	}

	/** Advance the spinner frame (called by the container's single clock). */
	tick(): void {
		this.spinner.tick();
	}

	/** Status line: ` ⠋ "title" (12.3s)` — accent spinner, bashMode title, muted meta. */
	statusLine(theme: Theme): string {
		const label = safeTitle(this.agent.title, 40);
		const elapsed = formatDuration(Date.now() - this.agent.startedAt);
		// Meta is parenthesized like every other component's meta (bash
		// `(timeout 10s)`, notification `(Took …)`); `·` only separates
		// multiple meta items, so a lone elapsed time drops it.
		return ` ${theme.fg("accent", this.spinner.current())} ${theme.fg("bashMode", label)} ${theme.fg("muted", `(${elapsed})`)}`;
	}

	/**
	 * Latest-activity excerpt, aligned to the title column — shared format
	 * with the tool card activity row (activityRow in format.ts).
	 */
	excerpt(theme: Theme): string | null {
		const activity = this.agent.getLatestActivity();
		return activity ? `${EXCERPT_INDENT}${activityRow(activity, theme, 60)}` : null;
	}
}

export class AgentWidget {
	private readonly ui: ExtensionUIContext;
	private readonly rows = new Map<string, AgentRow>();
	private interval: ReturnType<typeof setInterval> | undefined;
	private registered = false;
	private tui: { requestRender(): void } | undefined;

	constructor(ui: ExtensionUIContext) {
		this.ui = ui;
	}

	/** Track a background agent. No-op when the row is already present. */
	add(agent: AgentProcess): void {
		if (this.rows.has(agent.agentId)) return;
		this.rows.set(agent.agentId, new AgentRow(agent));
		this.ensureRunning();
	}

	/** Stop tracking (agent finished/stopped — the completion notification card takes over immediately). */
	remove(agentId: string): void {
		if (this.rows.delete(agentId) && this.rows.size === 0) {
			this.dispose();
			return;
		}
		this.tui?.requestRender();
	}

	/** Clear everything (session shutdown). */
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
		// Drop rows whose agent reached a terminal state.
		for (const [id, row] of this.rows) {
			if (row.agent.status !== "running") this.rows.delete(id);
			else row.tick();
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
		// pi already adds a leading Spacer(1) above extension widgets
		// (interactive-mode renderWidgetContainer, leadingSpacer=true) — no
		// manual blank line. 1-char left padding matches pi's string[] widget
		// form (Text(line, 1, 0)).
		const lines: string[] = [` ${theme.fg("accent", "\u25cf")} ${theme.fg("toolTitle", theme.bold("Agents"))}`];
		for (const row of this.rows.values()) {
			lines.push(row.statusLine(theme));

			const excerpt = row.excerpt(theme);
			if (excerpt) lines.push(excerpt);
		}
		return lines;
	}
}
