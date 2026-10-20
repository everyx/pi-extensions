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
import type { LiveTree } from "./live-tree.js";
import { resolveTreeAnchor } from "./tree-anchor.js";
import type { AgentWidget } from "./widget.js";

/** Apply an event to the local widget (pure data rows). `remove` is handled
 *  by the caller, which owns the cascade. */
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
	}
}

interface SubtreeDisplay {
	/** Anchor + deliver one telemetry event to its single surface. */
	onTreeEvent(event: AgentTreeEvent): void;
}

export function createSubtreeDisplay(opts: {
	hasParent: boolean;
	/** Authoritative lifecycle state — updated for EVERY event, whatever the
	 *  display anchor. A sub-agent has no widget (rpc mode) but still must
	 *  know its own subtree is alive to decide its own teardown. */
	live: LiveTree;
	/** Widget access — may lazily create it; undefined only in non-TUI. */
	getWidget(): AgentWidget | undefined;
	/** Parent seam: report verbatim upward (non-root only). */
	forward(event: AgentTreeEvent): void;
}): SubtreeDisplay {
	return {
		onTreeEvent(event: AgentTreeEvent): void {
			// Lifecycle first, and unconditionally: display routing must never
			// decide whether an agent is allowed to be torn down.
			const { removed } = opts.live.observe(event);
			switch (resolveTreeAnchor({ hasParent: opts.hasParent })) {
				case "forward":
					opts.forward(event.op === "add" ? { ...event, depth: event.depth + 1 } : event);
					return;
				case "widget": {
					const widget = opts.getWidget();
					if (!widget) return;
					if (event.op === "remove") {
						for (const id of removed) widget.remove(id, id === event.id ? event.status : "stopped");
						return;
					}
					applyTreeEvent(widget, event);
				}
			}
		},
	};
}
