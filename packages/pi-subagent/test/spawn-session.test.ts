import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCompletion } from "../agent-process.js";
import { holdUntilDrained, runSpawnSession, type SpawnSessionAgent } from "../spawn-session.js";

/** Literal fake — the structural SpawnSessionAgent interface makes this
 *  possible without mocking AgentProcess. */
function fakeAgent(overrides: Partial<SpawnSessionAgent> & { completion?: AgentCompletion } = {}) {
	const { completion, ...rest } = overrides;
	const calls: string[] = [];
	const agent: SpawnSessionAgent & { calls: string[] } = {
		agentId: "t1",
		label: "Test",
		model: "m/1",
		thinking: undefined,
		startedAt: 1000,
		persistent: false,
		status: "queued",
		stoppedByControl: false,
		spawnAndSend: async (prompt) => {
			calls.push(`send:${prompt}`);
			return { ok: true };
		},
		waitForCompletion: async () =>
			completion ?? { status: "completed", output: "done output", stats: { tokens: 1, toolUses: 0, durationMs: 5 } },
		stop: async () => {
			calls.push("stop");
		},
		getEvents: () => [{ kind: "text", text: "fake event" }],
		...rest,
		calls,
	};
	return agent;
}

describe("runSpawnSession — one path, never blocking", () => {
	it("returns as soon as the child accepted the task", async () => {
		const agent = fakeAgent();
		const o = await runSpawnSession(agent, { task: "do" });
		assert.equal(o.kind, "started");
		assert.equal(o.agent, agent);
		assert.equal(o.startedAt, 1000);
		assert.ok(agent.calls.includes("send:do"));
	});

	it("does not stop the child — it runs on its own", async () => {
		const agent = fakeAgent();
		await runSpawnSession(agent, { task: "do" });
		assert.ok(!agent.calls.includes("stop"), "a started spawn leaves the child running");
	});

	it("fires onStarting before the prompt, onStarted after", async () => {
		const agent = fakeAgent();
		const order: string[] = [];
		agent.spawnAndSend = async () => {
			order.push("send");
			return { ok: true };
		};
		await runSpawnSession(agent, {
			task: "do",
			hooks: { onStarting: () => order.push("starting"), onStarted: () => order.push("started") },
		});
		assert.deepEqual(order, ["starting", "send", "started"]);
	});

	it("spawn failure → spawn-failed, child stopped, no onStarted", async () => {
		const agent = fakeAgent({ spawnAndSend: async () => ({ ok: false, error: "no model" }) });
		let started = false;
		const o = await runSpawnSession(agent, { task: "do", hooks: { onStarted: () => (started = true) } });
		assert.deepEqual(o, { kind: "spawn-failed", error: "no model" });
		assert.ok(agent.calls.includes("stop"));
		assert.equal(started, false, "a failed spawn has no live agent to report");
	});

	it("abort while queued stops the child and never starts it", async () => {
		const controller = new AbortController();
		const agent = fakeAgent({
			spawnAndSend: async () => {
				controller.abort(); // pre-abort: the listener has already run
				return { ok: true };
			},
		});
		await runSpawnSession(agent, { task: "do", signal: controller.signal });
		assert.ok(agent.calls.includes("stop"));
	});

	it("a late abort does not stop an agent that already started", async () => {
		const controller = new AbortController();
		const agent = fakeAgent();
		await runSpawnSession(agent, { task: "do", signal: controller.signal });
		controller.abort();
		assert.ok(!agent.calls.includes("stop"), "the listener detaches once the spawn settled");
	});

	it("a throwing spawn stops the child and rethrows", async () => {
		const agent = fakeAgent({
			spawnAndSend: async () => {
				throw new Error("boom");
			},
		});
		await assert.rejects(() => runSpawnSession(agent, { task: "do" }), /boom/);
		assert.ok(agent.calls.includes("stop"));
	});
});

describe("holdUntilDrained — an agent outlives its own turn", () => {
	it("an empty subtree is not held: no onHeld, no waiting", async () => {
		let held = false;
		const waited = await holdUntilDrained({
			hasLiveDescendants: () => false,
			waitForDrain: async () => {
				throw new Error("must not wait");
			},
			onHeld: () => (held = true),
		});
		assert.equal(waited, false);
		assert.equal(held, false);
	});

	it("live descendants hold it: mark first, then wait, then proceed", async () => {
		const order: string[] = [];
		const waited = await holdUntilDrained({
			hasLiveDescendants: () => true,
			waitForDrain: async () => {
				order.push("drained");
			},
			onHeld: () => order.push("held"),
		});
		assert.equal(waited, true);
		assert.deepEqual(order, ["held", "drained"], "the row goes idle before the wait, not after");
	});

	it("propagates a rejection instead of reporting a clean finish", async () => {
		await assert.rejects(
			() =>
				holdUntilDrained({
					hasLiveDescendants: () => true,
					waitForDrain: async () => {
						throw new Error("widget gone");
					},
					onHeld: () => {},
				}),
			/widget gone/,
		);
	});
});
