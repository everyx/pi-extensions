/**
 * pi-subagent — live agent tree: who is alive, and under whom.
 *
 * This is lifecycle state, not display state. The drain rule asks it whether
 * an agent may be torn down yet, and the answer must be identical in every
 * run mode — TUI, RPC, headless. The widget is one *view* of this tree; it
 * must never be the source of truth, or the lifecycle becomes mode-dependent.
 *
 * That distinction is not theoretical: every sub-agent runs `pi --mode rpc`,
 * where no widget exists at all. Asking the widget would silently answer
 * "nothing is alive under me" there, and a sub-agent would take its own
 * children down as soon as its turn ended.
 *
 * Parent links come from tree telemetry (each node reports its direct spawns,
 * `parent` preserved across hops) and from local spawns. Ids are unique for
 * the life of the session.
 */

import type { AgentTreeEvent } from "./event-interpret.js";

export interface LiveTree {
	/** Track `agentId` as alive under `parent` ("" = the root session). */
	add(agentId: string, parent: string): void;
	/** Mark an agent dead; returns every id that went with it — the agent
	 *  itself first, then its descendants (a dead agent's subtree is dead:
	 *  the processes die with it and never report their own removal). */
	remove(agentId: string): string[];
	/** Apply one telemetry event; `removed` carries the cascade of a remove. */
	observe(event: AgentTreeEvent): { removed: string[] };
	/** Is anything alive nested under `agentId`, at any depth? */
	hasLiveDescendants(agentId: string): boolean;
	/** Resolve once nothing is nested under `agentId` any more — immediately
	 *  when it already has none, and also when the agent itself is gone. */
	whenDrained(agentId: string): Promise<void>;
	/** Live ids, for tests and diagnostics. */
	liveIds(): string[];
}

export function createLiveTree(): LiveTree {
	const parentOf = new Map<string, string>();
	const live = new Set<string>();
	const waiters = new Map<string, () => void>();

	const childrenOf = (agentId: string): string[] => {
		const out: string[] = [];
		for (const [id, parent] of parentOf) {
			if (parent === agentId && live.has(id)) out.push(id);
		}
		return out;
	};

	const hasLiveDescendants = (agentId: string): boolean => {
		for (const id of childrenOf(agentId)) {
			if (live.has(id)) return true;
			if (hasLiveDescendants(id)) return true;
		}
		return false;
	};

	/** A removal can drain any ancestor that was waiting on it. */
	const releaseDrained = (): void => {
		for (const [id, resolve] of [...waiters]) {
			// The waiter itself being gone also ends the wait: there is nothing
			// left to keep alive.
			if (live.has(id) && hasLiveDescendants(id)) continue;
			waiters.delete(id);
			resolve();
		}
	};

	const remove = (agentId: string): string[] => {
		if (!live.has(agentId)) return [];
		// Depth-first so descendants come before their parent in the list; the
		// caller drops rows one by one, order does not matter, but a stable
		// order keeps tests readable.
		const removed: string[] = [];
		const collect = (id: string): void => {
			for (const child of childrenOf(id)) collect(child);
			removed.push(id);
		};
		collect(agentId);
		for (const id of removed) {
			live.delete(id);
			parentOf.delete(id);
		}
		releaseDrained();
		return removed;
	};

	return {
		add(agentId, parent) {
			if (!agentId) return;
			live.add(agentId);
			if (parent && parent !== agentId) parentOf.set(agentId, parent);
			else parentOf.delete(agentId);
		},
		remove,
		observe(event) {
			if (event.op === "add") {
				this.add(event.id, event.parent ?? "");
				return { removed: [] };
			}
			if (event.op === "remove") return { removed: remove(event.id) };
			return { removed: [] };
		},
		hasLiveDescendants,
		whenDrained(agentId) {
			if (!live.has(agentId) || !hasLiveDescendants(agentId)) return Promise.resolve();
			return new Promise((resolve) => waiters.set(agentId, resolve));
		},
		liveIds() {
			return [...live];
		},
	};
}
