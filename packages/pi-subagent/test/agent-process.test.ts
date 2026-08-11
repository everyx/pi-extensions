/**
 * Tests for AgentProcess semantics (agent-process.ts).
 *
 * The stateful transport (rpc-client.ts) is NOT tested — a fake client is
 * injected via the `createClient` seam so we can drive the state machine
 * deterministically: spawnAndSend → settle → completion,
 * hard abort, external stop, and failure paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentProcess, type AgentProcessOptions } from "../agent-process.js";
import type { AgentActivity } from "../event-interpret.js";
import type { RpcClientOptions } from "../rpc-client.js";

/** Programmable fake standing in for RpcClient. */
class FakeClient {
	commands: Array<{ type: string; message?: string }> = [];
	endInputCalls = 0;
	killCalls = 0;
	exitCode: number | null = null;
	isClosed = false;
	/** argv captured at construction (--model/--tools/--session-dir). */
	args: string[] = [];
	/** env captured at construction (identity injection). */
	env: NodeJS.ProcessEnv | undefined;

	private onEvent?: (event: { type: string }) => void;
	private onExit?: () => void;
	private exitResolve!: (v: { code: number | null; signal: string | null }) => void;
	private exitPromise = new Promise<{ code: number | null; signal: string | null }>((r) => {
		this.exitResolve = r;
	});

	/** Simulated session stats returned by get_session_stats. */
	stats: { tokens: number; toolCalls: number } = { tokens: 100, toolCalls: 2 };
	/** Simulated preflight result. */
	promptOk = true;
	/** Simulated last assistant text. */
	lastText = "final answer";
	/** Simulated captured stderr (crash root cause). */
	stderrText = "";
	/** sessionFile/sessionId returned by get_state. */
	sessionFile = "/tmp/fake.jsonl";
	sessionId = "sess-1";

	constructor(options: RpcClientOptions) {
		this.onEvent = options.onEvent;
		this.onExit = options.onExit;
		this.args = options.args;
		this.env = options.env;
	}

	async sendCommand(command: { type: string; message?: string }) {
		this.commands.push(command);
		switch (command.type) {
			case "prompt":
				return this.promptOk
					? { type: "response", command: "prompt", success: true }
					: { type: "response", command: "prompt", success: false, error: "preflight failed" };
			case "get_state":
				return {
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionFile: this.sessionFile, sessionId: this.sessionId },
				};
			case "get_session_stats":
				return {
					type: "response",
					command: "get_session_stats",
					success: true,
					data: { tokens: { total: this.stats.tokens }, toolCalls: this.stats.toolCalls },
				};
			case "get_last_assistant_text":
				return {
					type: "response",
					command: "get_last_assistant_text",
					success: true,
					data: { text: this.lastText },
				};
			case "steer":
			case "abort":
				return { type: "response", command: command.type, success: true };
			default:
				return { type: "response", command: command.type, success: true };
		}
	}

	emitSettled(): void {
		this.onEvent?.({ type: "agent_settled" });
	}

	emitEvent(event: {
		type: string;
		assistantMessageEvent?: {
			type: string;
			delta?: unknown;
			toolCall?: { id?: unknown; name?: unknown; arguments?: unknown };
		};
		messages?: Array<{ role?: string; stopReason?: string; errorMessage?: unknown; content?: unknown[] }>;
		message?: {
			content?: Array<{
				type?: string;
				text?: unknown;
				thinking?: unknown;
				name?: unknown;
				arguments?: unknown;
				id?: unknown;
			}>;
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
		{ ...options, agentId: options.agentId ?? "a1", title: options.title ?? "test agent" },
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

	it("passes thinking level through as --thinking", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", title: "explore", thinking: "high" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--thinking", "high", "--name", "explore"]);
	});

	it("omits --thinking when no level is given (inherit main session)", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", title: "explore" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--name", "explore"]);
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

	it("hard-stops a child that never settles after timeout", async () => {
		const { agent, fake } = makeAgent({
			cwd: "/tmp",
			timeoutMs: 30,
			abortSettleGraceMs: 20,
		});
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion(); // no settle ever arrives

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
		assert.ok(
			fake.commands.some((c) => c.type === "abort"),
			"abort was sent",
		);
		assert.equal(fake.endInputCalls, 1, "child was hard-stopped via stdin EOF");
		assert.equal(agent.stoppedByControl, false, "timeout escalation is not a user-controlled stop");
	});

	it("does not hard-stop when the child settles within the abort grace window", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", timeoutMs: 30, abortSettleGraceMs: 500 });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		await new Promise((r) => setTimeout(r, 40)); // deadline passes → abort
		fake.emitSettled(); // settles inside the grace window

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
		assert.equal(fake.endInputCalls, 0, "grace settle avoids the hard stop");
	});

	it("waits forever when no timeoutMs is given (no hidden deadline)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		// No settle, no explicit timeout — the wait must stay pending rather
		// than escalating to an abort/stop. Probe for a spell, then release.
		let resolved = false;
		const completionPromise = agent.waitForCompletion().then((c) => {
			resolved = true;
			return c;
		});
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(resolved, false, "no deadline → no automatic stop");
		assert.ok(!fake.commands.some((c) => c.type === "abort"), "no abort was sent");

		fake.emitSettled();
		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
	});

	it("marks failed when the child exits non-zero without settling", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1); // crash — no settle, onExit releases waiters

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
	});

	it("surfaces captured stderr as the output when a failed child left no text", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = ""; // no assistant output before the crash
		fake.stderrText = "FATAL: bad API key";

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1);

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "FATAL: bad API key");
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
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
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
	it("tracks streamed text as the latest activity", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Found 5 files" },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "text", text: "Found 5 files" });
	});

	it("tracks thinking while the agent is reasoning", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "Let me analyze the structure" },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "thinking", text: "" });
	});

	it("summarizes tool calls with the friendly argument key", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { name: "bash", arguments: { command: "sleep 20" } },
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", name: "bash", args: "sleep 20" });
	});

	it("summarizes tool calls with JSON when no friendly key exists", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { name: "custom_tool", arguments: { foo: 1 } },
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", name: "custom_tool", args: '{"foo":1}' });
	});

	it("returns null before any message_update", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		assert.equal(agent.getLatestActivity(), null);
	});

	it("fires onActivityChange for thinking and tool transitions", async () => {
		const events: AgentActivity[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onActivityChange: (a) => events.push(a) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "analyzing…" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		});

		assert.deepEqual(events, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "bash", args: "ls" },
		]);
	});

	it("records every tool call and collapses consecutive thinking", async () => {
		const events: AgentActivity[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", onActivityChange: (a) => events.push(a) });

		// Two thinking_delta deltas → one thinking marker (dedup).
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "one" } });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "two" } });
		// Two bash calls → two tool rows, both recorded.
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "read", arguments: { path: "a.ts" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "read", arguments: { path: "b.ts" } } },
		});

		assert.deepEqual(events, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "read", args: "a.ts" },
			{ kind: "tool", name: "read", args: "b.ts" },
		]);
		assert.deepEqual(
			agent.getEvents().map((e) => e.kind),
			["thinking", "tool", "tool"],
		);
	});

	it("accumulates thinking, tool, and text events in order", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const starter = agent.spawnAndSend("prompt");
		fake.emitEvent({ type: "agent_settled" }); // acks spawn
		await starter;

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " world" },
		});

		assert.deepEqual(agent.getEvents(), [
			{ kind: "thinking" },
			{ kind: "tool", name: "bash", args: "ls" },
			{ kind: "text", text: "hello world" },
		]);
	});

	it("records each toolcall_end as its own tool event", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const starter = agent.spawnAndSend("prompt");
		fake.emitEvent({ type: "agent_settled" }); // acks spawn
		await starter;

		// Each tool call arrives as one authoritative toolcall_end (v0.84 — no
		// incremental snapshots to merge anymore); text deltas interleave.
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			},
		});
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call_2", name: "read", arguments: { path: "a.ts" } },
			},
		});
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y" } });

		assert.deepEqual(agent.getEvents(), [
			{ kind: "tool", name: "bash", args: "echo hi", id: "call_1" },
			{ kind: "text", text: "x" },
			{ kind: "tool", name: "read", args: "a.ts", id: "call_2" },
			{ kind: "text", text: "y" },
		]);
	});
});

describe("AgentProcess — persistent / in-tree messages", () => {
	it("persistent flags through to the process", () => {
		const { agent } = makeAgent({ cwd: "/tmp", persistent: true });
		assert.equal(agent.persistent, true);
		const { agent: plain } = makeAgent({ cwd: "/tmp" });
		assert.equal(plain.persistent, false);
	});

	it("sendMessage delivers a prompt with streamingBehavior steer (unified delivery)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const ok = await agent.sendMessage("[from ] focus on errors");
		assert.equal(ok, true);
		const last = fake.commands[fake.commands.length - 1];
		assert.equal(last?.type, "prompt");
		assert.equal((last as { streamingBehavior?: string })?.streamingBehavior, "steer");
		assert.equal((last as { message?: string })?.message, "[from ] focus on errors");
	});

	it("sendMessage returns false on a failed preflight", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptOk = false;
		assert.equal(await agent.sendMessage("hi"), false);
	});

	it("sendMessage wakes an idle persistent agent back to running", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done; // → completed, process kept (persistent)
		assert.equal(agent.status, "completed");
		assert.equal(await agent.sendMessage("continue"), true);
		assert.equal(agent.status, "running");
	});

	it("a settle after wake returns the persistent agent to completed (idle)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		await agent.sendMessage("continue");
		fake.emitSettled();
		assert.equal(agent.status, "completed");
	});

	it("in-tree messages from the child fire onMessage", () => {
		const received: Array<{ to: string; from: string; message: string }> = [];
		const { fake } = makeAgent({ cwd: "/tmp", onMessage: (m) => received.push(m) });
		fake.emitEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "pi-subagent-msg",
			statusText: JSON.stringify({ to: "@parent", from: "a1", message: "need help" }),
		} as never);
		assert.deepEqual(received, [{ to: "@parent", from: "a1", message: "need help" }]);
	});

	it("identity env is passed to the child", () => {
		const { fake } = makeAgent({ cwd: "/tmp", env: { PI_SUBAGENT_AGENT_ID: "a1", PI_SUBAGENT_PARENT: "" } });
		assert.ok(fake.env);
		assert.equal(fake.env.PI_SUBAGENT_AGENT_ID, "a1");
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
