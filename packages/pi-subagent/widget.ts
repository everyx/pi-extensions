/**
 * pi-subagent — AgentWidget.
 *
 * Persistent above-editor widget showing one status line per tracked agent:
 * `⠋ label (42.0s)`, plus a latest-activity excerpt line aligned under the
 * label. Backed by the shared pi-ui StatusWidget (generic foreground
 * indicator for background work); the agent-specific part is the row data
 * (AgentProcess → WidgetItem) and the activity excerpt.
 *
 * Tracked: background agents (direct or nested under a background ancestor)
 * and persistent foreground agents. A foreground card's whole subtree is
 * folded into that card's meta counters instead — one subtree, one surface.
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

	/** Track an agent row. `status` is the row's lifecycle state at
	 * registration — the caller knows it (background settle = running,
	 * foreground resident = idle). Never derived from agent.status: at
	 * resident time the process is already "completed", and a terminal row
	 * status is removed by the widget's terminal cleanup on the spot.
	 * No-op when the row is already present. */
	add(agent: AgentProcess, status: "running" | "idle" = "running"): void {
		this.widget.add({
			id: agent.agentId,
			// @id — label: the user matches the @name the LLM mentions in chat.
			title: `@${agent.agentId} — ${agent.label}`,
			startedAt: agent.startedAt,
			status,
			rows: activityToRows(agent.getLatestActivity()),
		});
	}

	/** Track a nested agent (tree telemetry from a descendant's own spawns):
	 *  pure data — no local AgentProcess behind the row. */
	addNested(agent: {
		agentId: string;
		label: string;
		startedAt: number;
		indent: number;
		status: "running" | "idle";
	}): void {
		this.widget.add({
			id: agent.agentId,
			title: `@${agent.agentId} — ${agent.label}`,
			startedAt: agent.startedAt,
			status: agent.status === "idle" ? "idle" : "running",
			indent: agent.indent,
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
