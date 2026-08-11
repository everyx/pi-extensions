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
import type { AgentMessage } from "../protocol.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "../registry.js";

// ── Fakes ──────────────────────────────────────────────────

class FakeAgent implements RegisteredAgent {
	readonly agentId: string;
	readonly title: string;
	readonly persistent?: boolean;
	stoppedByControl = false;
	stopCalls = 0;
	stopped = false;
	/** sendMessage deliveries (texts). */
	delivered: string[] = [];
	sendOk = true;

	constructor(agentId: string, title = "fake", persistent = false) {
		this.agentId = agentId;
		this.title = title;
		this.persistent = persistent;
	}

	async sendMessage(text: string): Promise<boolean> {
		this.delivered.push(text);
		return this.sendOk;
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
	statuses: Array<{ id: string; status: string }> = [];

	add(agent: RegisteredAgent): void {
		this.added.push(agent.agentId);
	}
	remove(agentId: string): void {
		this.removed.push(agentId);
	}
	setStatus(agentId: string, status: "idle" | "running"): void {
		this.statuses.push({ id: agentId, status });
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

function makeRegistry(widget: FakeWidget | null = new FakeWidget(), hasParent = false) {
	const notified: Array<{ agentId: string; status: string }> = [];
	const registry = new AgentRegistry({
		notify: (agent, c) => {
			notified.push({ agentId: agent.agentId, status: c.status });
		},
		getWidget: () => widget,
		hasParent,
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

	it("suppresses the notification for agent_stop (deliberate user action)", async () => {
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

describe("AgentRegistry — persistent (idle) completion", () => {
	it("notifies but keeps the process and bookkeeping (idle)", async () => {
		const { registry, widget, notified } = makeRegistry();
		const agent = new FakeAgent("a1", "stay", true);
		registry.register(agent);

		await registry.complete(agent, completion());

		assert.deepEqual(notified, [{ agentId: "a1", status: "completed" }]);
		assert.equal(agent.stopCalls, 0, "process stays resident");
		assert.equal(registry.lookup("a1"), agent, "still registered (agent_stop removes later)");
		assert.deepEqual(widget?.removed, [], "widget row kept");
	});

	it("a persistent agent that failed still cleans up (only completed goes idle)", async () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a1", "stay", true);
		registry.register(agent);

		await registry.complete(agent, completion({ status: "failed" }));

		assert.equal(agent.stopCalls, 1);
		assert.equal(registry.lookup("a1"), undefined);
		assert.deepEqual(widget?.removed, ["a1"]);
	});

	it("a persistent idle agent can be stopped and removed", async () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a1", "stay", true);
		registry.register(agent);
		await registry.complete(agent, completion());

		assert.equal(await registry.stopAndRemove("a1"), true);
		assert.equal(agent.stopCalls, 1);
		assert.equal(registry.lookup("a1"), undefined);
		assert.deepEqual(widget?.removed, ["a1"]);
	});

	it("flips the widget row to idle on persistent completion", async () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a1", "stay", true);
		registry.register(agent);
		await registry.complete(agent, completion());
		assert.deepEqual(widget?.statuses, [{ id: "a1", status: "idle" }]);
	});

	it("does not flip idle for non-persistent completion", async () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a1");
		registry.register(agent);
		await registry.complete(agent, completion());
		assert.deepEqual(widget?.statuses, []);
	});
});

describe("AgentRegistry — in-tree routing", () => {
	const msg = (to: string, from = "a1"): AgentMessage => ({ to, from, message: "hi" });

	it("routes a direct child for delivery", () => {
		const { registry } = makeRegistry(null);
		registry.register(new FakeAgent("a2"));
		const d = registry.route(msg("a2"));
		assert.deepEqual(d, { kind: "child", childId: "a2", message: msg("a2") });
	});

	it("routes @parent to the parent when this process is a child", () => {
		const { registry } = makeRegistry(null, true);
		assert.equal(registry.route(msg("@parent")).kind, "parent");
	});

	it("errors @parent at the root session", () => {
		const { registry } = makeRegistry(null, false);
		assert.equal(registry.route(msg("@parent", "")).kind, "error");
	});

	it("uplinks unknown targets when a parent exists, errors at root", () => {
		const { registry: child } = makeRegistry(null, true);
		assert.equal(child.route(msg("zzz")).kind, "uplink");
		const { registry: root } = makeRegistry(null, false);
		assert.equal(root.route(msg("zzz", "")).kind, "error");
	});

	it("delivers a message to a direct child via its sendMessage", async () => {
		const { registry } = makeRegistry(null);
		const agent = new FakeAgent("a2");
		registry.register(agent);
		assert.equal(await registry.deliver("a2", "[from ] hi"), true);
		assert.deepEqual(agent.delivered, ["[from ] hi"]);
	});

	it("delivery flips the widget row to running (woke an idle agent)", async () => {
		const { registry, widget } = makeRegistry();
		const agent = new FakeAgent("a2", "stay", true);
		registry.register(agent);
		await registry.complete(agent, completion());
		if (widget) widget.statuses.length = 0; // reset the idle flip
		assert.equal(await registry.deliver("a2", "continue"), true);
		assert.deepEqual(widget?.statuses, [{ id: "a2", status: "running" }]);
	});

	it("markIdle flips the row back to idle (wake finished)", () => {
		const { registry, widget } = makeRegistry();
		registry.register(new FakeAgent("a2", "stay", true));
		registry.markIdle("a2");
		assert.deepEqual(widget?.statuses, [{ id: "a2", status: "idle" }]);
	});

	it("deliver returns false for unknown or un-deliverable agents", async () => {
		const { registry } = makeRegistry(null);
		assert.equal(await registry.deliver("zzz", "hi"), false);
		const plain = new FakeAgent("a2");
		(plain as { sendMessage?: unknown }).sendMessage = undefined;
		registry.register(plain);
		assert.equal(await registry.deliver("a2", "hi"), false);
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
