/**
 * pi-subagent — subtree display: where a child's telemetry lands.
 *
 * Every tree event resolves to exactly one surface:
 *   - forward → verbatim to my parent (depth + 1)
 *   - widget  → rows on the root widget
 *
 * There is no third "fold into the open card" case: every spawn is
 * non-blocking, so no card is ever open while its subtree runs.
 *
 * The interface is the test surface: drive events through onTreeEvent with
 * fake seams and assert forwarding and widget application.
 */

import type { AgentTreeEvent } from "./event-interpret.js";
import { resolveTreeAnchor } from "./tree-anchor.js";
import type { AgentWidget } from "./widget.js";

/** Apply a forwarded tree event to the root widget (pure data rows). */
function applyTreeEvent(widget: AgentWidget, event: AgentTreeEvent): void {
	switch (event.op) {
		case "add":
			widget.addNested({
				agentId: event.id,
				label: event.label,
				startedAt: event.startedAt,
				indent: event.depth,
				status: event.status,
				parentId: event.parent,
			});
			break;
		case "activity":
			widget.updateActivity(event.id, event.activity);
			break;
		case "remove":
			widget.remove(event.id, event.status);
			break;
	}
}

interface SubtreeDisplay {
	/** Anchor + deliver one telemetry event to its single surface. */
	onTreeEvent(event: AgentTreeEvent): void;
}

export function createSubtreeDisplay(opts: {
	hasParent: boolean;
	/** Widget access — may lazily create it; undefined only in non-TUI. */
	getWidget(): AgentWidget | undefined;
	/** Parent seam: report verbatim upward (non-root only). */
	forward(event: AgentTreeEvent): void;
}): SubtreeDisplay {
	return {
		onTreeEvent(event: AgentTreeEvent): void {
			switch (resolveTreeAnchor({ hasParent: opts.hasParent })) {
				case "forward":
					opts.forward(event.op === "add" ? { ...event, depth: event.depth + 1 } : event);
					return;
				case "widget": {
					const widget = opts.getWidget();
					if (widget) applyTreeEvent(widget, event);
				}
			}
		},
	};
}
