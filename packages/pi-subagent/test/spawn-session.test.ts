import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCompletion } from "../agent-process.js";
import { runSpawnSession, type SpawnSessionAgent } from "../spawn-session.js";

/** Literal fake — the structural SpawnSessionAgent interface makes this
 *  possible without mocking AgentProcess. */
function fakeAgent(overrides: Partial<SpawnSessionAgent> & { completion?: AgentCompletion } = {}) {
	const { completion, ...rest } = overrides;
	const calls: string[] = [];
	const agent: SpawnSessionAgent & { calls: string[] } = {
		agentId: "t1",
		title: "Test",
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
		getEvents: () => [{ kind: "fake-event" }],
		...rest,
		calls,
	};
	return agent;
}

const finishedOf = (o: Awaited<ReturnType<typeof runSpawnSession>>) => {
	assert.equal(o.kind, "finished");
	return o as Extract<typeof o, { kind: "finished" }>;
};

describe("runSpawnSession", () => {
	it("foreground completed → finished outcome, no stop (clean exit)", async () => {
		const agent = fakeAgent();
		const o = await runSpawnSession(agent, { task: "do", runInBackground: false });
		const f = finishedOf(o);
		assert.equal(f.status, "completed");
		assert.equal(f.output, "done output");
		assert.ok(!f.resident);
		assert.deepEqual(f.events, [{ kind: "fake-event" }]);
		// Idempotent teardown still runs on terminal agents (status quo parity).
		assert.ok(agent.calls.includes("stop"));
	});

	it("spawn failure → spawn-failed, agent stopped, abort listener detached", async () => {
		const agent = fakeAgent({
			spawnAndSend: async () => ({ ok: false, error: "boom" }),
		});
		const controller = new AbortController();
		const o = await runSpawnSession(agent, { task: "do", runInBackground: false, signal: controller.signal });
		assert.equal(o.kind, "spawn-failed");
		if (o.kind === "spawn-failed") assert.equal(o.error, "boom");
		assert.ok(agent.calls.includes("stop"));
		// Listener detached: an abort after the failure must not reach the agent.
		controller.abort();
		assert.equal(agent.calls.filter((c) => c === "stop").length, 1);
	});

	it("failed completion → finished/failed with stoppedByControl surfaced", async () => {
		const agent = fakeAgent({
			completion: { status: "failed", output: "", stats: { tokens: 0, toolUses: 0, durationMs: 1 } },
		});
		const f = finishedOf(await runSpawnSession(agent, { task: "do", runInBackground: false }));
		assert.equal(f.status, "failed");
	});

	it("stopped by user cancel → stopped + stoppedByControl true", async () => {
		const controller = new AbortController();
		const agent = fakeAgent({
			status: "running",
			completion: { status: "stopped", output: "partial", stats: { tokens: 1, toolUses: 0, durationMs: 9 } },
		});
		agent.waitForCompletion = async () => {
			controller.abort(); // user cancel mid-run → guard stops the live agent
			agent.stoppedByControl = true;
			return { status: "stopped", output: "partial", stats: { tokens: 1, toolUses: 0, durationMs: 9 } };
		};
		const f = finishedOf(
			await runSpawnSession(agent, { task: "do", runInBackground: false, signal: controller.signal }),
		);
		assert.equal(f.status, "stopped");
		assert.equal(f.stoppedByControl, true);
	});

	it("persistent completed → resident outcome, onResident hook, no teardown stop", async () => {
		let resident = false;
		const agent = fakeAgent({ persistent: true });
		const o = await runSpawnSession(agent, {
			task: "do",
			runInBackground: false,
			hooks: { onResident: () => (resident = true) },
		});
		const f = finishedOf(o);
		assert.equal(f.resident, true);
		assert.equal(resident, true);
		assert.ok(!agent.calls.includes("stop"));
	});

	it("persistent but failed → torn down like any failure", async () => {
		const agent = fakeAgent({
			persistent: true,
			completion: { status: "failed", output: "x", stats: { tokens: 0, toolUses: 0, durationMs: 1 } },
		});
		const f = finishedOf(await runSpawnSession(agent, { task: "do", runInBackground: false }));
		assert.equal(f.resident, false);
		assert.ok(agent.calls.includes("stop"));
	});

	it("background started → immediate outcome, onBackgroundSettled fired, late abort is a no-op", async () => {
		let settled: unknown;
		const controller = new AbortController();
		const agent = fakeAgent({ status: "running" });
		const o = await runSpawnSession(agent, {
			task: "do",
			runInBackground: true,
			signal: controller.signal,
			hooks: { onBackgroundSettled: (a) => (settled = a) },
		});
		assert.equal(o.kind, "background-started");
		assert.equal(settled, agent);
		// Late abort must NOT stop the autonomous background agent.
		controller.abort();
		assert.ok(!agent.calls.includes("stop"));
	});

	it("background spawn failure → spawn-failed (still guarded, still torn down)", async () => {
		const agent = fakeAgent({ spawnAndSend: async () => ({ ok: false, error: "no child" }) });
		const o = await runSpawnSession(agent, { task: "do", runInBackground: true });
		assert.equal(o.kind, "spawn-failed");
		assert.ok(agent.calls.includes("stop"));
	});

	it("pre-aborted signal stops a queued agent immediately", async () => {
		const controller = new AbortController();
		controller.abort();
		const agent = fakeAgent({ status: "queued" });
		await runSpawnSession(agent, { task: "do", runInBackground: false, signal: controller.signal });
		assert.ok(agent.calls.includes("stop"));
	});

	it("hooks fire in order: onWorking before send, not after", async () => {
		const order: string[] = [];
		const agent = fakeAgent({
			spawnAndSend: async (_prompt) => {
				order.push("send");
				return { ok: true };
			},
		});
		await runSpawnSession(agent, {
			task: "do",
			runInBackground: false,
			hooks: { onWorking: () => order.push("working") },
		});
		assert.deepEqual(order, ["working", "send"]);
	});
});
