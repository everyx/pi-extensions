/**
 * pi-subagent — AgentWidget.
 *
 * Persistent above-editor widget showing one status line per *background*
 * agent: `⠋ <title> · 42.0s`, plus a latest-activity excerpt line aligned
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
import { activityRow, formatDuration, SPINNER } from "./render.js";

// Same frames and cadence as pi-tui Loader's DEFAULT_FRAMES / DEFAULT_INTERVAL_MS.
// (SPINNER lives in render.ts — shared with the stop animation.)

const WIDGET_KEY = "subagents";
const TICK_MS = 80;

/** How long a finished agent lingers in the widget (confirmation window). */
const FINISHED_LINGER_MS = 4000;

/** Widget line indent: 1 (widget padding) + ⠋ + space → excerpt aligns with the title. */
const EXCERPT_INDENT = "   ";

interface WidgetRow {
	agent: AgentProcess;
	frame: number;
}

/** Finished agent snapshot — lingers briefly so the user can confirm the outcome. */
interface FinishedRow {
	title: string;
	status: string;
	startedAt: number;
	completedAt: number;
}

interface WidgetRender {
	render(): string[];
	invalidate(): void;
}

export class AgentWidget {
	private readonly ui: ExtensionUIContext;
	private readonly rows = new Map<string, WidgetRow>();
	/** Finished agents lingering briefly with their terminal status (icon + elapsed). */
	private readonly finished = new Map<string, FinishedRow>();
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

	/** Stop tracking (agent finished/stopped — lingers briefly, then the notification card takes over). */
	remove(agentId: string): void {
		const row = this.rows.get(agentId);
		if (row) {
			this.rows.delete(agentId);
			this.finished.set(agentId, {
				title: row.agent.title,
				status: row.agent.status,
				startedAt: row.agent.startedAt,
				completedAt: Date.now(),
			});
			// Keep ticking through the linger window so the finished row clears.
			this.ensureRunning();
		}
		if (this.rows.size === 0 && this.finished.size === 0) {
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
		this.finished.clear();
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
		// Running rows animate; agents that reached a terminal state move to
		// the finished linger list (defensive — registry.remove is the main path).
		for (const [id, row] of this.rows) {
			if (row.agent.status !== "running") {
				this.rows.delete(id);
				if (!this.finished.has(id)) {
					this.finished.set(id, {
						title: row.agent.title,
						status: row.agent.status,
						startedAt: row.agent.startedAt,
						completedAt: Date.now(),
					});
				}
			} else {
				row.frame++;
			}
		}
		// Drop finished rows after their linger window.
		const now = Date.now();
		for (const [id, finishedRow] of this.finished) {
			if (now - finishedRow.completedAt > FINISHED_LINGER_MS) this.finished.delete(id);
		}
		if (this.rows.size === 0 && this.finished.size === 0) {
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
		const lines: string[] = [` ${theme.fg("accent", `\u25cf ${theme.fg("accent", "Agents")}`)}`];
		for (const row of this.rows.values()) {
			const { agent, frame } = row;
			const spinner = theme.fg("accent", SPINNER[frame % SPINNER.length]);
			// Task label — same as the session display name (no prefix).
			const name = agent.title;
			const elapsed = formatDuration(Date.now() - agent.startedAt);
			lines.push(` ${spinner} ${theme.fg("muted", `${name} \u00b7 ${elapsed}`)}`);

			const activity = agent.getLatestActivity();
			if (activity) lines.push(this.renderExcerpt(activity, theme));
		}
		// Finished agents lingering briefly: `✓ <title> · 3.2s · stopped`.
		for (const f of this.finished.values()) {
			const icon = f.status === "completed" ? "\u2713" : f.status === "failed" ? "\u2717" : "\u25a0";
			const color = f.status === "completed" ? "success" : f.status === "failed" ? "error" : "warning";
			const elapsed = formatDuration(f.completedAt - f.startedAt);
			lines.push(` ${theme.fg(color, icon)} ${theme.fg("muted", `${f.title} \u00b7 ${elapsed} \u00b7 ${f.status}`)}`);
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
