/**
 * pi-subagent — nested-subtree counters for one foreground card.
 *
 * Every descendant spawn of a foreground card's agent — at any depth,
 * foreground or background — folds into one count set here, fed by tree
 * events arriving at the anchor boundary (index.ts onTreeEvent). Rendered
 * in the card header meta with the widget's vocabulary:
 * `done n/total · N running · N failed · N stopped`.
 *
 * Pure and table-testable: no pi API, no registry.
 */

import type { AgentTreeEvent } from "./event-interpret.js";

export interface NestedCounters {
	total: number;
	running: number;
	idle: number;
	done: number;
	failed: number;
	stopped: number;
}

/**
 * Stateful folder: one instance per foreground card. Tracks known ids so
 * double adds (persistent child: "running" at settle, "idle" when resident)
 * transition instead of double-counting. Activity events are excerpt
 * material, not counts; running clamps ≥ 0 against transient reorderings.
 */
export function createNestedFold() {
	const counters: NestedCounters = { total: 0, running: 0, idle: 0, done: 0, failed: 0, stopped: 0 };
	const rows = new Map<string, "running" | "idle">();
	return {
		snapshot(): NestedCounters {
			return { ...counters };
		},
		fold(event: AgentTreeEvent): void {
			if (event.op === "activity") return;
			if (event.op === "add") {
				const prev = rows.get(event.id);
				if (!prev) {
					counters.total++;
					counters[event.status]++;
				} else if (prev !== event.status) {
					// Status transition (persistent descendant running → resident
					// idle): move between live buckets, total untouched.
					counters[prev] = Math.max(0, counters[prev] - 1);
					counters[event.status]++;
				}
				rows.set(event.id, event.status);
				return;
			}
			// remove: the item leaves the live set but stays in total/done —
			// `done n/total` semantics match the widget's lifetime counters.
			const prev = rows.get(event.id);
			if (prev === undefined) return;
			rows.delete(event.id);
			counters[prev] = Math.max(0, counters[prev] - 1);
			counters[event.status]++;
		},
	};
}
