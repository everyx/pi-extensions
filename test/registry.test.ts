/**
 * Tests for the AgentRegistry lifecycle policy (registry.ts).
 *
 * The registry owns the running-agent bookkeeping (map entry + widget row +
 * child process) and the completion policy that used to live inline in
 * index.ts tool executes — which was untested. Narrow seams (notify callback,
 * widget surface) let every policy branch run without a pi API or a TUI.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCompletion } from "../agent-process.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "../registry.js";

// ── Fakes ──────────────────────────────────────────────────

class FakeAgent implements RegisteredAgent {
	readonly agentId: string;
	readonly title: string;
	stoppedByControl = false;
	stopCalls = 0;
	stopped = false;

	constructor(agentId: string, title = "fake") {
		this.agentId = agentId;
		this.title = title;
	}

	async stop(): Promise<void> {
		this.stopCalls++;
		this.stopped = true;
		// AgentProcess.stop() semantics: any stop flags the agent as
		// user-controlled — later completions must not notify.
		this.stoppedByControl = true;
	}
}

class FakeWidget implements WidgetSurface {
	added: string[] = [];
	removed: string[] = [];
	disposed = false;

	add(agent: RegisteredAgent): void {
		this.added.push(agent.agentId);
	}
	remove(agentId: string): void {
		this.removed.push(agentId);
	}
	dispose(): void {
		this.disposed = true;
	}
}

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
	return {
		status: "completed",
		output: "done",
		stats: { tokens: 10, toolUses: 1, durationMs: 100 },
		...overrides,
	};
}

function makeRegistry(widget: FakeWidget | null = new FakeWidget()) {
	const notified: Array<{ agentId: string; status: string }> = [];
	const registry = new AgentRegistry({
		notify: (agent, c) => {
			notified.push({ agentId: agent.agentId, status: c.status });
		},
		getWidget: () => widget,
	});
	return { registry, widget, notified };
}

// ── Tests ──────────────────────────────────────────────────

describe("AgentRegistry — tracking", () => {
	it("register adds the map entry and the widget row", () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a1");

		registry.register(agent);

		assert.equal(registry.lookup("a1"), agent);
		assert.deepEqual(widget?.added, ["a1"]);
	});

	it("register is a no-op for the widget when there is none (non-TUI)", () => {
		const { registry } = makeRegistry(null);
		registry.register(new FakeAgent("a1"));
		assert.equal(registry.lookup("a1")?.agentId, "a1");
	});

	it("nextAgentId yields sequential short ids (a1, a2, …)", () => {
		const { registry } = makeRegistry(null);
		assert.equal(registry.nextAgentId(), "a1");
		assert.equal(registry.nextAgentId(), "a2");
		assert.equal(registry.nextAgentId(), "a3");
	});

	it("lookup returns undefined for unknown ids", () => {
		const { registry } = makeRegistry();
		assert.equal(registry.lookup("nope"), undefined);
	});
});

describe("AgentRegistry — completion policy", () => {
	it("notifies on completion and cleans up (widget row, map entry, child)", async () => {
		const { registry, widget, notified } = makeRegistry();
		const agent = new FakeAgent("a1");
		registry.register(agent);

		await registry.complete(agent, completion({ status: "completed" }));

		assert.deepEqual(notified, [{ agentId: "a1", status: "completed" }]);
		assert.deepEqual(widget?.removed, ["a1"]);
		assert.equal(registry.lookup("a1"), undefined);
		assert.equal(agent.stopped, true);
	});

	it("suppresses the notification for AgentControl stops (deliberate user action)", async () => {
		const { registry, widget, notified } = makeRegistry();
		const agent = new FakeAgent("a1");
		agent.stoppedByControl = true;
		registry.register(agent);

		await registry.complete(agent, completion({ status: "stopped" }));

		assert.deepEqual(notified, []);
		assert.deepEqual(widget?.removed, ["a1"]);
		assert.equal(registry.lookup("a1"), undefined);
	});

	it("notifies with status stopped for timeout/hard-stop completions (not user-controlled)", async () => {
		const { registry, notified } = makeRegistry();
		const agent = new FakeAgent("a1");
		registry.register(agent);

		await registry.complete(agent, completion({ status: "stopped" }));

		assert.deepEqual(notified, [{ agentId: "a1", status: "stopped" }]);
	});

	it("works for spawn-failure completions of agents that were never registered", async () => {
		const { registry, widget, notified } = makeRegistry();
		const agent = new FakeAgent("a1");

		await registry.complete(agent, completion({ status: "failed", output: "preflight failed" }));

		assert.deepEqual(notified, [{ agentId: "a1", status: "failed" }]);
		assert.deepEqual(widget?.removed, []);
		assert.equal(agent.stopped, true);
	});

	it("does not notify again when complete runs after stopAndRemove", async () => {
		const { registry, notified } = makeRegistry();
		const agent = new FakeAgent("a1");
		registry.register(agent);

		await registry.stopAndRemove("a1");
		await registry.complete(agent, completion());

		assert.deepEqual(notified, []);
	});
});

describe("AgentRegistry — stop / shutdown", () => {
	it("stopAndRemove stops the child and removes both bookkeeping entries", async () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a1");
		registry.register(agent);

		const stopped = await registry.stopAndRemove("a1");

		assert.equal(stopped, true);
		assert.equal(agent.stopped, true);
		assert.equal(agent.stopCalls, 1);
		assert.deepEqual(widget?.removed, ["a1"]);
		assert.equal(registry.lookup("a1"), undefined);
	});

	it("stopAndRemove reports false for unknown ids (already finished)", async () => {
		const { registry } = makeRegistry();
		const stopped = await registry.stopAndRemove("nope");
		assert.equal(stopped, false);
	});

	it("shutdown stops every agent, clears the map, and disposes the widget", async () => {
		const { registry, widget } = makeRegistry();
		const a1 = new FakeAgent("a1");
		const a2 = new FakeAgent("a2");
		registry.register(a1);
		registry.register(a2);

		await registry.shutdown();

		assert.equal(a1.stopped, true);
		assert.equal(a2.stopped, true);
		assert.equal(registry.lookup("a1"), undefined);
		assert.equal(registry.lookup("a2"), undefined);
		assert.equal(widget?.disposed, true);
	});
});
