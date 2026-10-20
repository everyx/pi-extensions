/**
 * pi-subagent — pending reports: the completion reports that are queued but
 * not yet in the transcript.
 *
 * A notification reaches pi as a steer message, and pi hands it to the model
 * at the parent's next tool boundary — not the moment the child finishes. In
 * that window the report exists but nobody has read it: the widget row is
 * already gone (the agent finished) and the card is not there yet. Left
 * unsaid, the two events look like one thing happening twice.
 *
 * pi shows its own queued messages in exactly that window (`Steering:` /
 * `Follow-up:` lines above the editor, gone when delivered). Our notification
 * rides pi's agent-level steering queue, which that block does not read — so
 * we render the same idea ourselves: one dim line per undelivered report,
 * removed the moment its card lands.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { capPlain, structRow } from "@everyx/pi-ui/width.js";
import type { AgentCompletion } from "./agent-process.js";
import { NOTIFICATION_CUSTOM_TYPE } from "./notification.js";
import { agentTitle } from "./views.js";

/** Own widget key — the agent rows live under pi-ui's, so both can coexist. */
const WIDGET_KEY = "pi-subagent-pending";

/** Longest content slice a queued line keeps: the render layer clips to the
 *  terminal anyway, and a report can be huge — flattening it on every frame
 *  would not. */
const HEAD_MAX = 200;

type CompletionStatus = AgentCompletion["status"];

/** A report that is not a plain completion says how it ended; a completed one
 *  needs no word — the report's own existence is the word. Same vocabulary as
 *  the card's status tail (agent-process statuses are those words). */
function outcomeWord(status: CompletionStatus): string | undefined {
	return status === "completed" ? undefined : status;
}

/** First non-empty line of the report — the line is an indicator, not a
 *  reading surface (the card that follows carries the full output). */
function head(output: string): string {
	for (const line of output.split(/\r?\n/)) {
		const text = line.trim();
		if (text) return text;
	}
	return "";
}

/**
 * One queued report, as the user reads it while it waits:
 *
 *   Agent @abe — counter (queued): bg done
 *   Agent @abe — counter (failed · queued): <first line of the error>
 *
 * `(queued)` is the state of this report, the colon introduces what the agent
 * said — the same grammar as the widget row and the card tail. The word is
 * pi's queue vocabulary, so the line reads as a member of pi's own queued
 * block, one row above it.
 */
export function pendingLine(
	agent: { agentId: string; label: string },
	completion: { status: CompletionStatus; output: string },
): string {
	const state = [outcomeWord(completion.status), "queued"].filter((part) => part !== undefined).join(" · ");
	const title = `Agent ${agentTitle(agent.agentId, agent.label)} (${state})`;
	const text = capPlain(head(completion.output), HEAD_MAX);
	return text ? `${title}: ${text}` : title;
}

/**
 * Which agent's report a transcript message is — undefined when it is not one
 * of our notification cards. pi emits message events for the custom message
 * we sent (role "custom", our customType, our details), so the agent id there
 * identifies the queued line this message settles.
 */
export function reportOf(message: unknown): string | undefined {
	const m = message as { role?: unknown; customType?: unknown; details?: { agent_id?: unknown } } | undefined;
	if (m?.role !== "custom" || m.customType !== NOTIFICATION_CUSTOM_TYPE) return undefined;
	return typeof m.details?.agent_id === "string" ? m.details.agent_id : undefined;
}

interface PendingEntry {
	agentId: string;
	line: string;
}

/**
 * The queued-report lines above the editor.
 *
 * One line per undelivered report, in completion order; a line goes away when
 * its card lands — so its lifetime is exactly the report's trip through pi's
 * steering queue, and the two events the user sees (line disappears, card
 * appears) are one event. Nothing else removes a line: a session that dies
 * mid-flight takes the widget with it.
 */
export class PendingReports {
	private readonly ui: ExtensionUIContext;
	/** Insertion-ordered; the key exists so a report can be settled by agent. */
	private readonly entries = new Map<number, PendingEntry>();
	private nextId = 1;
	private registered = false;
	private tui: { requestRender(): void } | undefined;

	constructor(ui: ExtensionUIContext) {
		this.ui = ui;
	}

	/** Show a report as queued — called the moment the notification is handed
	 *  to pi, i.e. before pi can have rendered its card. */
	add(agent: { agentId: string; label: string }, completion: { status: CompletionStatus; output: string }): void {
		this.entries.set(this.nextId++, { agentId: agent.agentId, line: pendingLine(agent, completion) });
		this.refresh();
	}

	/** One of our notification cards landed in the transcript: that report is
	 *  delivered — drop its line (the oldest first: a resident agent can report
	 *  more than once, and reports land in the order they were queued). */
	settle(message: unknown): void {
		const agentId = reportOf(message);
		if (!agentId) return;
		for (const [id, entry] of this.entries) {
			if (entry.agentId !== agentId) continue;
			this.entries.delete(id);
			this.refresh();
			return;
		}
	}

	/** Session shutdown: the widget goes with the session. */
	dispose(): void {
		this.entries.clear();
		if (this.registered) {
			this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
		}
		this.tui = undefined;
	}

	/** Register while lines exist, unregister when the last one lands. */
	private refresh(): void {
		if (this.entries.size === 0) {
			if (this.registered) {
				this.ui.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			return;
		}
		if (!this.registered) {
			this.ui.setWidget(
				WIDGET_KEY,
				(tui: unknown, theme: Theme) => {
					this.tui = tui as { requestRender(): void };
					return {
						render: (width: number) => this.render(theme, width),
						invalidate: () => {
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		}
		this.tui?.requestRender();
	}

	/** One dim line per queued report — pi's queued-message shape: single
	 *  physical line, capped to the terminal width. */
	private render(theme: Theme, width: number): string[] {
		return [...this.entries.values()].map((entry) =>
			structRow({
				prefix: " ",
				content: entry.line,
				width,
				styleContent: (capped) => theme.fg("dim", capped),
			}),
		);
	}
}
