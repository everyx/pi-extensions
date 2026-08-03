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
 * Visual + animation follow pi's built-in working indicator (Loader):
 * same Braille frames, 80ms interval, accent spinner + muted message.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentActivity, AgentProcess } from "./agent-process.js";

// Same frames and cadence as pi-tui Loader's DEFAULT_FRAMES / DEFAULT_INTERVAL_MS.
const SPINNER = ["\u281b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

const WIDGET_KEY = "subagents";
const TICK_MS = 80;

/** Widget line indent: 1 (widget padding) + ⠋ + space → excerpt aligns with the title. */
const EXCERPT_INDENT = "   ";

/** Excerpt length cap; long tails get a leading ellipsis. */
const EXCERPT_MAX = 60;

function truncateTail(s: string): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= EXCERPT_MAX) return clean;
	return `\u2026${clean.slice(clean.length - EXCERPT_MAX + 1)}`;
}

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
		// 1-char left padding matches pi's string[] widget form (Text(line, 1, 0)).
		const lines: string[] = [` ${theme.fg("accent", `\u25cf ${theme.fg("accent", "Agents")}`)}`];
		for (const row of this.rows.values()) {
			const { agent, frame } = row;
			const spinner = theme.fg("accent", SPINNER[frame % SPINNER.length]);
			// Task label — same as the session display name (no prefix).
			const name = agent.title ?? agent.sessionName ?? `sub-agent ${agent.agentId.slice(0, 8)}`;
			const elapsed = formatElapsed(Date.now() - agent.startedAt);
			lines.push(` ${spinner} ${theme.fg("muted", `${name} \u00b7 ${elapsed}`)}`);

			const activity = agent.getLatestActivity();
			if (activity) lines.push(this.renderExcerpt(activity, theme));
		}
		return lines;
	}

	/**
	 * Latest-activity excerpt, aligned to the title column (pi's hidden-thinking
	 * style for thinking; colored tool name for tool calls; plain text otherwise).
	 */
	private renderExcerpt(activity: AgentActivity, theme: Theme): string {
		if (activity.kind === "thinking") {
			// Identical to pi's hidden-thinking label: italic + thinkingText.
			return `${EXCERPT_INDENT}${theme.italic(theme.fg("thinkingText", "Thinking..."))}`;
		}
		if (activity.kind === "tool") {
			// "bash: sleep 20" — tool name in toolTitle, args muted.
			const colon = activity.text.indexOf(": ");
			if (colon > 0) {
				const toolName = activity.text.slice(0, colon);
				const args = activity.text.slice(colon + 2);
				return `${EXCERPT_INDENT}${theme.fg("toolTitle", toolName)}: ${theme.fg("muted", truncateTail(args))}`;
			}
			return `${EXCERPT_INDENT}${theme.fg("toolTitle", truncateTail(activity.text))}`;
		}
		return `${EXCERPT_INDENT}${theme.fg("muted", truncateTail(activity.text))}`;
	}
}
