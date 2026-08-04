/**
 * pi-subagent — AgentWidget.
 *
 * Persistent above-editor widget showing one status line per *background*
 * agent: `⠋ <title> (42.0s)`, plus a latest-activity excerpt line aligned
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
import type { AgentActivity, AgentProcess } from "./agent-process.js";
import { activityRow, formatDuration, SPINNER, safeTitle } from "./render.js";

// Same frames and cadence as pi-tui Loader's DEFAULT_FRAMES / DEFAULT_INTERVAL_MS.
// (SPINNER lives in render.ts — shared with the stop animation.)

const WIDGET_KEY = "subagents";
const TICK_MS = 80;

/** Widget line indent: 1 (widget padding) + ⠋ + space → excerpt aligns with the title. */
const EXCERPT_INDENT = "   ";

interface WidgetRow {
	agent: AgentProcess;
	frame: number;
}

interface WidgetRender {
	render(): string[];
	invalidate(): void;
}

export class AgentWidget {
	private readonly ui: ExtensionUIContext;
	private readonly rows = new Map<string, WidgetRow>();
	private interval: ReturnType<typeof setInterval> | undefined;
	private registered = false;
	private tui: { requestRender(): void } | undefined;

	constructor(ui: ExtensionUIContext) {
		this.ui = ui;
	}

	/** Track a background agent. No-op when the row is already present. */
	add(agent: AgentProcess): void {
		if (this.rows.has(agent.agentId)) return;
		this.rows.set(agent.agentId, { agent, frame: 0 });
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
			else row.frame++;
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
			const { agent, frame } = row;
			const spinner = theme.fg("accent", SPINNER[frame % SPINNER.length]);
			// Task label — same colors as the card header title (bashMode quotes),
			// rendered safe for one line: newlines/quotes flattened, capped
			// (mirrors safeTitle in render.ts).
			const label = safeTitle(agent.title, 40);
			const elapsed = formatDuration(Date.now() - agent.startedAt);
			// Meta is parenthesized like every other component's meta (bash
			// `(timeout 10s)`, notification `(Took …)`); `·` only separates
			// multiple meta items, so a lone elapsed time drops it.
			lines.push(` ${spinner} ${theme.fg("bashMode", `"${label}"`)} ${theme.fg("muted", `(${elapsed})`)}`);

			const activity = agent.getLatestActivity();
			if (activity) lines.push(this.renderExcerpt(activity, theme));
		}
		return lines;
	}

	/**
	 * Latest-activity excerpt, aligned to the title column — shared format
	 * with the tool card activity row (activityRow in render.ts).
	 */
	private renderExcerpt(activity: AgentActivity, theme: Theme): string {
		return `${EXCERPT_INDENT}${activityRow(activity, theme, 60)}`;
	}
}
