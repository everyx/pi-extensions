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
import { StatusWidget } from "@everyx/pi-ui/widget.js";
import type { AgentProcess } from "./agent-process.js";
import { activityRow } from "./format.js";

export class AgentWidget {
	private readonly widget: StatusWidget;

	constructor(ui: ExtensionUIContext) {
		this.widget = new StatusWidget(ui);
	}

	/** Track a background agent. No-op when the row is already present. */
	add(agent: AgentProcess): void {
		this.widget.add({
			id: agent.agentId,
			title: agent.title,
			startedAt: agent.startedAt,
			isActive: () => agent.status === "running",
			excerpt: (theme) => {
				const activity = agent.getLatestActivity();
				return activity ? activityRow(activity, theme, 60) : null;
			},
		});
	}

	/** Stop tracking (agent finished/stopped — the completion notification takes over immediately). */
	remove(agentId: string): void {
		this.widget.remove(agentId);
	}

	/** Clear everything (session shutdown). */
	dispose(): void {
		this.widget.dispose();
	}
}
