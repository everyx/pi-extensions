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
import { NOTIFICATION_CUSTOM_TYPE, type NotificationAgent } from "./notification.js";
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
	/** The report itself, kept so it can be handed to pi again: the line is
	 *  what the user sees, this is what the model must eventually receive. */
	report: PendingReport;
	/** When it was queued — a delivery started after a settle is still in
	 *  flight, and re-sending it would report the same result twice. */
	queuedAt: number;
	/** When it was last handed back for delivery, so a burst of settles inside
	 *  the retry delay cannot send the same report twice. */
	retriedAt?: number;
}

/** A retry is given this long to reach the transcript before the next settle is
 *  allowed to send it again: long enough that a landed card has settled its
 *  line, short enough that a lost retry is not waited on forever. */
const RETRY_COOLDOWN_MS = 5_000;

/** A report awaiting delivery, in the only shape driving it again needs. */
export interface PendingReport {
	agent: NotificationAgent;
	completion: AgentCompletion;
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

	private readonly retryCooldownMs: number;

	constructor(ui: ExtensionUIContext, opts: { retryCooldownMs?: number } = {}) {
		this.ui = ui;
		this.retryCooldownMs = opts.retryCooldownMs ?? RETRY_COOLDOWN_MS;
	}

	/** Show a report as queued — called the moment the notification is handed
	 *  to pi, i.e. before pi can have rendered its card. */
	add(agent: NotificationAgent, completion: AgentCompletion): void {
		this.entries.set(this.nextId++, {
			agentId: agent.agentId,
			line: pendingLine(agent, completion),
			report: { agent, completion },
			queuedAt: Date.now(),
		});
		this.refresh();
	}

	/**
	 * Hand every report that never landed back to the caller for delivery.
	 *
	 * A line lives exactly as long as its card is missing, and pi settles a run
	 * only when nothing queued will run — so a report still waiting once the run
	 * is over was lost, not delayed. Esc wipes the queue it was riding
	 * (`restoreQueuedMessagesToEditor` → `agent.clearAllQueues`), and a run that
	 * fails to start drops it before it is ever queued. Neither is visible from
	 * here, but the evidence is the same: the card never came.
	 *
	 * Two things keep one report from being sent twice. A report queued after
	 * the settle is on a delivery that has not had its turn yet, and a report
	 * retried moments ago may be on one right now — settles can arrive in bursts,
	 * and each arms its own timer.
	 *
	 * A retry cannot collide with a first attempt that is merely slow: a settle
	 * means the queue is empty (`_handlePostAgentRun` continues while
	 * `hasQueuedMessages()`), so a message still waiting in it never gets this
	 * far. The one exception is an aborted run outside the TUI, where abort
	 * leaves the queue alone — there the same result can be reported twice, which
	 * is the cheaper failure than a parent that never hears back.
	 */
	undelivered(queuedBefore: number, deliver: (report: PendingReport) => void): number {
		const now = Date.now();
		let handed = 0;
		for (const entry of this.entries.values()) {
			if (entry.queuedAt > queuedBefore) continue;
			if (entry.retriedAt !== undefined && now - entry.retriedAt < this.retryCooldownMs) continue;
			entry.retriedAt = now;
			deliver(entry.report);
			handed++;
		}
		return handed;
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
