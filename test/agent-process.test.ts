/**
 * Tests for AgentProcess semantics (src/agent-process.ts).
 *
 * The stateful transport (rpc-client.ts) is NOT tested — a fake client is
 * injected via the `createClient` seam so we can drive the state machine
 * deterministically: spawnAndSend → settle → completion, wrap-up steering,
 * hard abort, external stop, and failure paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentProcess, type AgentProcessOptions } from "../src/agent-process.js";
import type { RpcClientOptions } from "../src/rpc-client.js";

/** Programmable fake standing in for RpcClient. */
class FakeClient {
	commands: Array<{ type: string; message?: string }> = [];
	endInputCalls = 0;
	killCalls = 0;
	exitCode: number | null = null;
	isClosed = false;
	/** argv captured at construction (--model/--tools/--session-dir). */
	args: string[] = [];

	private onEvent?: (event: { type: string }) => void;
	private onExit?: () => void;
	private exitResolve!: (v: { code: number | null; signal: string | null }) => void;
	private exitPromise = new Promise<{ code: number | null; signal: string | null }>((r) => {
		this.exitResolve = r;
	});

	/** Simulated session stats returned by get_session_stats. */
	stats: { tokens: number; toolCalls: number } = { tokens: 100, toolCalls: 2 };
	/** Simulated prompt preflight result. */
	promptOk = true;
	/** Simulated last assistant text. */
	lastText = "final answer";
	/** sessionFile/sessionId returned by get_state. */
	sessionFile = "/tmp/fake.jsonl";
	sessionId = "sess-1";

	constructor(options: RpcClientOptions) {
		this.onEvent = options.onEvent;
		this.onExit = options.onExit;
		this.args = options.args;
	}

	async sendCommand(command: { id: string; type: string; message?: string }) {
		this.commands.push(command);
		switch (command.type) {
			case "prompt":
				return this.promptOk
					? { id: command.id, type: "response", command: "prompt", success: true }
					: { id: command.id, type: "response", command: "prompt", success: false, error: "preflight failed" };
			case "get_state":
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionFile: this.sessionFile, sessionId: this.sessionId },
				};
			case "get_session_stats":
				return {
					id: command.id,
					type: "response",
					command: "get_session_stats",
					success: true,
					data: { tokens: { total: this.stats.tokens }, toolCalls: this.stats.toolCalls },
				};
			case "get_last_assistant_text":
				return {
					id: command.id,
					type: "response",
					command: "get_last_assistant_text",
					success: true,
					data: { text: this.lastText },
				};
			case "steer":
			case "abort":
				return { id: command.id, type: "response", command: command.type, success: true };
			default:
				return { id: command.id, type: "response", command: command.type, success: true };
		}
	}

	emitSettled(): void {
		this.onEvent?.({ type: "agent_settled" });
	}

	emitEvent(event: {
		type: string;
		assistantMessageEvent?: { type: string; delta?: unknown };
		messages?: Array<{ role?: string; stopReason?: string; errorMessage?: unknown; content?: unknown[] }>;
		message?: {
			content?: Array<{ type?: string; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown }>;
		};
	}): void {
		this.onEvent?.(event as never);
	}

	emitExit(code: number): void {
		this.exitCode = code;
		this.isClosed = true;
		this.onExit?.();
		this.exitResolve({ code, signal: null });
	}

	endInput(): void {
		this.endInputCalls++;
		this.emitExit(0);
	}

	kill(): void {
		this.killCalls++;
	}

	waitForExit(): Promise<{ code: number | null; signal: string | null }> {
		return this.exitPromise;
	}
}

function makeAgent(options: Partial<AgentProcessOptions> & { cwd: string }): { agent: AgentProcess; fake: FakeClient } {
	let fake!: FakeClient;
	const agent = new AgentProcess(
		{ ...options },
		{
			createClient: (opts: RpcClientOptions) => {
				fake = new FakeClient(opts);
				return fake as never;
			},
		},
	);
	return { agent, fake };
}

describe("AgentProcess — spawnAndSend", () => {
	it("moves to running and captures session info on prompt ack", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", title: "my task" });
		const started = await agent.spawnAndSend("do it");
		assert.deepEqual(started, { ok: true });
		assert.equal(agent.status, "running");
		assert.equal(agent.sessionPath, "/tmp/fake.jsonl");
		assert.equal(agent.sessionId, "sess-1");
		assert.ok(agent.agentId.length > 0);
		// prompt + get_state commands were sent
		assert.deepEqual(
			fake.commands.map((c) => c.type),
			["prompt", "get_state"],
		);
	});

	it("fails with the preflight error and stays failed", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptOk = false;
		const started = await agent.spawnAndSend("do it");
		assert.deepEqual(started, { ok: false, error: "preflight failed" });
		assert.equal(agent.status, "failed");
	});

	it("passes model/tools/sessionDir through and sets --name when title is given", () => {
		const { fake } = makeAgent({
			cwd: "/tmp",
			model: "google/gemini-x",
			tools: ["read", "grep"],
			title: "explore",
			sessionName: "explore",
			sessionDir: "/home/u/.pi/agent/subagent-sessions",
		});
		assert.deepEqual(fake.args, [
			"--model",
			"google/gemini-x",
			"--tools",
			"read,grep",
			"--name",
			"explore",
			"--session-dir",
			"/home/u/.pi/agent/subagent-sessions",
		]);
	});

	it("omits --name when no title is given (pi default firstMessage)", () => {
		const { fake } = makeAgent({
			cwd: "/tmp",
			model: "google/gemini-x",
			sessionDir: "/home/u/.pi/agent/subagent-sessions",
		});
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--session-dir", "/home/u/.pi/agent/subagent-sessions"]);
	});

	it("passes thinking level through as --thinking", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", thinking: "high" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--thinking", "high"]);
	});

	it("omits --thinking when no level is given (inherit main session)", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x"]);
	});
});

describe("AgentProcess — waitForCompletion", () => {
	it("completes after the first settle", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
		assert.equal(completion.output, "final answer");
		assert.equal(completion.stats.tokens, 100);
		assert.equal(completion.stats.toolUses, 2);
		assert.ok(completion.stats.durationMs >= 0);
		assert.equal(completion.sessionPath, "/tmp/fake.jsonl");
	});

	it("steers wrap-up when tokens cross the threshold, then completes", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", wrapUpTokens: 50, hardLimitTokens: 1_000_000 });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitSettled(); // first turn: tokens 100 ≥ wrapUp 50 → steer
		fake.emitSettled(); // second turn (after steer): still under hard limit → complete

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
		const steerCmds = fake.commands.filter((c) => c.type === "steer");
		assert.equal(steerCmds.length, 1);
		assert.match(steerCmds[0]?.message ?? "", /wrap up/i);
	});

	it("hard-aborts when tokens cross the hard limit", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", wrapUpTokens: 50, hardLimitTokens: 100 });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitSettled(); // tokens 100 ≥ hardLimit 100 → abort
		fake.emitSettled(); // settle after abort

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
		assert.ok(fake.commands.some((c) => c.type === "abort"));
	});

	it("marks failed when the child exits non-zero without settling", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1); // crash — no settle, onExit releases waiters

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
	});
});

describe("AgentProcess — onDelta", () => {
	it("streams text_delta events from message_update", async () => {
		const deltas: string[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onDelta: (d) => deltas.push(d) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello " },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "World" },
		});
		fake.emitEvent({ type: "agent_settled" });

		assert.deepEqual(deltas, ["Hello ", "World"]);
	});

	it("ignores non-delta message updates", async () => {
		const deltas: string[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onDelta: (d) => deltas.push(d) });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
		assert.deepEqual(deltas, []);
	});
});

describe("AgentProcess — agent API errors", () => {
	it("marks failed with the API error when agent_end reports stopReason error", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = ""; // error turn produces no assistant text

		const completionPromise = agent.waitForCompletion();
		fake.emitEvent({
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limited" },
			],
		});
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "429 Rate limited");
	});

	it("stays completed when agent_end has no error stop reason", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
		});
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
	});
});

describe("AgentProcess — latest activity", () => {
	it("tracks text as the latest content part", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			message: {
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "Found 5 files" },
				],
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "text", text: "Found 5 files" });
	});

	it("tracks thinking while the agent is reasoning", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			message: { content: [{ type: "thinking", thinking: "Let me analyze the structure" }] },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "thinking", text: "Let me analyze the structure" });
	});

	it("summarizes tool calls with the friendly argument key", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			message: { content: [{ type: "toolCall", name: "bash", arguments: { command: "sleep 20" } }] },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", text: "bash: sleep 20" });
	});

	it("summarizes tool calls with JSON when no friendly key exists", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			message: { content: [{ type: "toolCall", name: "custom_tool", arguments: { foo: 1 } }] },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", text: 'custom_tool: {"foo":1}' });
	});

	it("returns null before any message_update", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		assert.equal(agent.getLatestActivity(), null);
	});
});

describe("AgentProcess — stop", () => {
	it("graceful stop flags stoppedByControl and ends stdin", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		await agent.stop();
		assert.equal(agent.status, "stopped");
		assert.equal(agent.stoppedByControl, true);
		assert.equal(fake.endInputCalls, 1);
	});

	it("interrupts a pending waitForCompletion with status stopped", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		await agent.stop(); // endInput → fake exits → onExit releases settle

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
	});
});
