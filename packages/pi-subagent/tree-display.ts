/**
 * pi-subagent — subtree display: where a child's telemetry lands.
 *
 * The 显示面统一规则 (SPEC) as one module. Given the anchor facts (am I the
 * root? is this child foreground? is my card still open?), every tree
 * event resolves to exactly one surface:
 *   - fold   → this card's nested counters (one subtree, one surface)
 *   - forward → verbatim to my parent (depth + 1)
 *   - widget → rows on the root widget
 *
 * The interface is the test surface: drive events through onTreeEvent with
 * fake seams and assert folding, forwarding, and widget application.
 */

import type { AgentTreeEvent } from "./event-interpret.js";
import { createNestedFold, type NestedCounters, resolveTreeAnchor } from "./nested-fold.js";
import type { AgentWidget } from "./widget.js";

/** Apply a forwarded tree event to the root widget (pure data rows). */
function applyTreeEvent(widget: AgentWidget, event: AgentTreeEvent): void {
	switch (event.op) {
		case "add":
			widget.addNested({
				agentId: event.id,
				title: event.title,
				startedAt: event.startedAt,
				indent: event.depth,
				status: event.status,
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
	/** Freeze the card (execute returned): from here folding would vanish —
	 *  persistent children surface on the widget instead. */
	closeCard(): void;
	/** Current descendant counters for the card meta. */
	nested(): NestedCounters;
}

export function createSubtreeDisplay(opts: {
	hasParent: boolean;
	/** Constant per spawn: is MY child a foreground edge (card owns it)? */
	foregroundEdge: boolean;
	/** Widget access — may lazily create it; undefined only in non-TUI. */
	getWidget(): AgentWidget | undefined;
	/** Parent seam: report verbatim upward (non-root only). */
	forward(event: AgentTreeEvent): void;
	/** Card seam: a fold changed the counters — refresh the live card. */
	onFold(): void;
}): SubtreeDisplay {
	const nested = createNestedFold();
	let cardClosed = false;
	return {
		onTreeEvent(event: AgentTreeEvent): void {
			switch (
				resolveTreeAnchor({
					hasParent: opts.hasParent,
					foregroundEdge: opts.foregroundEdge,
					cardClosed,
				})
			) {
				case "fold":
					nested.fold(event);
					opts.onFold();
					return;
				case "forward":
					opts.forward(event.op === "add" ? { ...event, depth: event.depth + 1 } : event);
					return;
				case "widget": {
					const widget = opts.getWidget();
					if (widget) applyTreeEvent(widget, event);
				}
			}
		},
		closeCard(): void {
			cardClosed = true;
		},
		nested() {
			return nested.snapshot();
		},
	};
}
