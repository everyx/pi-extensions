/**
 * pi-subagent — AgentWidget.
 *
 * Persistent above-editor widget showing one status line per *background*
 * agent: `⠋ <title> · 42s`. Foreground agents are intentionally
 * excluded — their live output already streams inline in the tool card
 * (mirrors tintinweb's default widget mode, which hides foreground runs).
 *
 * Status-only by design: no output preview, no navigation, no conversation
 * rendering. Full content arrives via the completion notification and
 * `pi --session <path>` review afterwards.
 *
 * Uses pi's setWidget callback form (registered once, refreshed via
 * requestRender), 500ms tick for spinner + elapsed. Clears itself when the
 * last agent finishes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentProcess } from "./agent-process.js";

const SPINNER = ["\u281b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

const WIDGET_KEY = "subagents";
const TICK_MS = 500;

interface WidgetRow {
	agent: AgentProcess;
	frame: number;
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
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

	/** Stop tracking (agent finished/stopped — the notification card takes over). */
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
		const lines: string[] = [theme.fg("toolTitle", `\u25cf ${theme.fg("toolTitle", "Agents")}`)];
		for (const row of this.rows.values()) {
			const { agent, frame } = row;
			const spinner = SPINNER[frame % SPINNER.length];
			// Task label — same as the session display name (no prefix).
			const name = agent.title ?? agent.sessionName ?? `sub-agent ${agent.agentId.slice(0, 8)}`;
			const elapsed = formatElapsed(Date.now() - agent.startedAt);
			lines.push(
				`${theme.fg("toolTitle", spinner)} ${theme.fg("toolOutput", name)} ${theme.fg("muted", `\u00b7 ${elapsed}`)}`,
			);
		}
		return lines;
	}
}
