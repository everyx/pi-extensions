/**
 * pi-subagent — AgentWidget.
 *
 * Persistent above-editor widget showing one status line per *background*
 * agent: `⠋ title (42.0s)`, plus a latest-activity excerpt line aligned
 * under the title. Backed by the shared pi-ui StatusWidget (generic
 * foreground indicator for background work); the agent-specific part is
 * the row data (AgentProcess → WidgetItem) and the activity excerpt.
 *
 * Foreground agents are intentionally excluded — their live output already
 * streams inline in the tool card.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WidgetResult, WidgetRow, WidgetStatus } from "@everyx/pi-ui/widget.js";
import { StatusWidget } from "@everyx/pi-ui/widget.js";
import type { AgentProcess } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";

export class AgentWidget {
	private readonly widget: StatusWidget;

	constructor(ui: ExtensionUIContext) {
		// Widget title marks the strip as the Agent plugin's background tasks
		// (v1.2.0 style) so users recognize it at a glance.
		this.widget = new StatusWidget(ui, "Agents");
	}

	/** Track a background agent. No-op when the row is already present. */
	add(agent: AgentProcess): void {
		this.widget.add({
			id: agent.agentId,
			// @id — title: the user matches the @name the LLM mentions in chat.
			title: `@${agent.agentId} — ${agent.title}`,
			startedAt: agent.startedAt,
			status: agent.status === "running" ? "running" : agent.status === "stopped" ? "stopped" : "done",
			rows: activityToRows(agent.getLatestActivity()),
		});
	}

	/** Stop tracking; the end result feeds the lifetime progress meta. */
	remove(agentId: string, result?: WidgetResult): void {
		this.widget.remove(agentId, result);
	}

	/** Update one row's status in place (idle ⇄ running for persistent agents). */
	setStatus(agentId: string, status: WidgetStatus): void {
		this.widget.updateStatus(agentId, status);
	}

	/** Update one row's live working output (activity excerpt). */
	updateActivity(agentId: string, activity: AgentActivity | undefined): void {
		this.widget.updateRows(agentId, activityToRows(activity));
	}

	/** Clear everything (session shutdown). */
	dispose(): void {
		this.widget.dispose();
	}
}

/** Map the latest activity to structured widget rows (pure data, not
 *  formatted). Width is unknown here — the widget render layer clips to the
 *  terminal width (width-aware tail truncation). Tool args are flattened to
 *  one line at this layer; text activity is passed through as-is (its
 *  newlines are flattened by clipTail at render time — both paths keep the
 *  zero-width-\n over-wide collapse impossible). */
export function activityToRows(activity: AgentActivity | undefined): WidgetRow[] {
	if (!activity) return [];
	if (activity.kind === "thinking") return [{ style: "thinking", content: "Thinking..." }];
	// Tool args can carry multi-line payloads (e.g. write) — flatten newlines
	// into a single excerpt line (tail truncation happens at render time).
	if (activity.kind === "tool")
		return [{ style: "tool", content: `${activity.name}: ${activity.args.replace(/\s+/g, " ")}` }];
	return [{ style: "text", content: activity.text }];
}
