/**
 * Integration: a nested spawn's lifecycle, wired from the real modules.
 *
 * The two halves of the drain rule are unit-tested (live-tree: who is alive;
 * holdUntilDrained: hold-then-release). Neither would catch a wrong WIRING
 * between them — a widget-driven check that silently no-ops without a TUI, for
 * instance. This file drives the composed path the way index.ts does:
 *
 *   spawn → register (registry + live tree) → turn ends → hold → subtree
 *   drains → report + stop
 *
 * Every case runs twice: once with a widget (TUI) and once with none. The
 * second run is the regression that matters — sub-agents are `pi --mode rpc`,
 * so "no widget" is their normal world, and the lifecycle must be identical.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCompletion } from "../agent-process.js";
import { createLiveTree } from "../live-tree.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "../registry.js";
import { finishWhenDrained } from "../spawn-session.js";
import { createSubtreeDisplay } from "../tree-display.js";

const completion = (status: AgentCompletion["status"] = "completed"): AgentCompletion => ({
	status,
	output: `${status} output`,
	stats: { tokens: 1, toolUses: 0, durationMs: 1 },
});

/** A registered agent whose stop is observable. */
function fakeAgent(agentId: string, label: string) {
	const record = { agentId, label, stops: 0, idle: 0 };
	const agent: RegisteredAgent = {
		agentId,
		label,
		stoppedByControl: false,
		stop: async () => {
			record.stops++;
		},
	};
	return { agent, record };
}

interface Harness {
	live: ReturnType<typeof createLiveTree>;
	registry: AgentRegistry;
	/** Present only in the TUI variant — the point of the second case is that
	 *  nothing below depends on it. */
	widget: WidgetSurface | null;
	notified: string[];
	/** Telemetry arriving from a child about ITS child. */
	telemetry(fromAgent: string): (event: Parameters<ReturnType<typeof createSubtreeDisplay>["onTreeEvent"]>[0]) => void;
	settle(): Promise<void>;
}

function harness(opts: { tui: boolean }): Harness {
	const live = createLiveTree();
	const notified: string[] = [];

	// Mirrors index.ts's widgetSurface(): lifecycle ALWAYS runs, drawing only
	// when a widget exists. Getting this wrong is the bug this file guards —
	// a null surface here deadlocks the chain exactly like the old code did.
	const widget: WidgetSurface = {
		add: (agent) => {
			live.add(agent.agentId, "");
			if (!opts.tui) return;
			void agent;
		},
		remove: (agentId) => {
			live.remove(agentId);
			if (!opts.tui) return;
		},
		setStatus: () => {},
		dispose: () => {},
	};

	const registry = new AgentRegistry({
		notify: (agent) => {
			notified.push(agent.agentId);
		},
		getWidget: () => widget,
	});

	return {
		live,
		registry,
		widget: opts.tui ? widget : null,
		notified,
		// The child reports its own spawns to us; index.ts routes and observes
		// them through the same module.
		telemetry: (_from: string) =>
			createSubtreeDisplay({
				hasParent: false,
				live,
				getWidget: () => undefined,
				forward: () => {},
			}).onTreeEvent,
		async settle() {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		},
	};
}

describe("nested spawn lifecycle — the drain rule end to end", () => {
	for (const tui of [true, false]) {
		const mode = tui ? "TUI" : "no widget (rpc / headless)";

		it(`${mode}: a parent whose child is still running is held, not stopped`, async () => {
			const h = harness({ tui });
			const outer = fakeAgent("outer", "Outer");
			h.registry.register(outer.agent);
			// The child announced itself under outer (telemetry), and is alive.
			h.telemetry("outer")({
				op: "add",
				id: "inner",
				label: "Inner",
				startedAt: 0,
				depth: 1,
				status: "running",
				parent: "outer",
			});
			assert.equal(h.live.hasLiveDescendants("outer"), true);

			// outer's own turn ends while inner still runs.
			const finishing = finishWhenDrained({
				agentId: "outer",
				live: h.live,
				onHeld: () => h.registry.markIdle("outer"),
				finish: () => h.registry.complete(outer.agent, completion()),
			});
			await h.settle();

			assert.equal(outer.record.stops, 0, "outer must not be stopped while inner runs");
			assert.deepEqual(h.notified, [], "outer must not report yet");
			assert.ok(h.registry.lookup("outer"), "outer stays addressable");

			// inner finishes → the subtree drains → outer is released.
			h.telemetry("outer")({ op: "remove", id: "inner", status: "done" });
			await finishing;

			assert.equal(outer.record.stops, 1, "outer is stopped once the subtree is empty");
			assert.deepEqual(h.notified, ["outer"], "outer reports exactly once");
			assert.equal(h.registry.lookup("outer"), undefined, "outer leaves the registry");
		});

		it(`${mode}: a parent with no descendants finishes immediately`, async () => {
			const h = harness({ tui });
			const solo = fakeAgent("solo", "Solo");
			h.registry.register(solo.agent);

			await finishWhenDrained({
				agentId: "solo",
				live: h.live,
				onHeld: () => assert.fail("nothing to hold"),
				finish: () => h.registry.complete(solo.agent, completion()),
			});

			assert.equal(solo.record.stops, 1);
			assert.deepEqual(h.notified, ["solo"]);
		});

		it(`${mode}: descendants at any depth keep the parent held`, async () => {
			// The parent only ever sees telemetry for a descendant's descendants
			// — the recursion in hasLiveDescendants is what keeps it honest.
			const h = harness({ tui });
			const a = fakeAgent("a", "A");
			h.registry.register(a.agent);
			h.telemetry("a")({ op: "add", id: "b", label: "B", startedAt: 0, depth: 1, status: "running", parent: "a" });
			h.telemetry("a")({ op: "add", id: "c", label: "C", startedAt: 0, depth: 2, status: "running", parent: "b" });

			const finishing = finishWhenDrained({
				agentId: "a",
				live: h.live,
				onHeld: () => h.registry.markIdle("a"),
				finish: () => h.registry.complete(a.agent, completion()),
			});
			await h.settle();
			assert.equal(a.record.stops, 0, "a grandchild still running holds A");

			h.telemetry("a")({ op: "remove", id: "c", status: "done" });
			await h.settle();
			assert.equal(a.record.stops, 0, "B is still alive, so A still waits");

			h.telemetry("a")({ op: "remove", id: "b", status: "done" });
			await finishing;
			assert.equal(a.record.stops, 1, "A is released only when the whole subtree is gone");
			assert.deepEqual(h.notified, ["a"]);
		});
	}
});
