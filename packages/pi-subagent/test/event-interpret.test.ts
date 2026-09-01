/**
 * Tests for the raw RpcEvent → AgentEvent interpretation layer
 * (event-interpret.ts).
 *
 * interpretEvent maps pi's rpc protocol vocabulary (assistantMessageEvent
 * deltas since v0.84.0, agent_end messages) onto our domain vocabulary. It
 * is a pure function — fed raw event shapes exactly as they arrive off the
 * wire, without any FakeClient indirection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AgentEvent, interpretEvent, MSG_STATUS_KEY, TREE_STATUS_KEY } from "../event-interpret.js";

function expect(raw: Record<string, unknown>): AgentEvent[] {
	return interpretEvent({ type: "x", ...raw });
}

describe("interpretEvent — agent_settled", () => {
	it("maps to a settled event", () => {
		assert.deepEqual(interpretEvent({ type: "agent_settled" }), [{ type: "settled" }]);
	});
});

describe("interpretEvent — message_update deltas", () => {
	it("extracts text_delta from assistantMessageEvent", () => {
		assert.deepEqual(
			expect({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
			[{ type: "text_delta", delta: "Hello " }],
		);
	});

	it("maps thinking_delta to a thinking marker", () => {
		assert.deepEqual(
			expect({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }),
			[{ type: "thinking" }],
		);
	});

	it("ignores non-delta assistant message events", () => {
		assert.deepEqual(expect({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } }), []);
		assert.deepEqual(expect({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "x" } }), []);
	});
});

describe("interpretEvent — message_update tool calls (v0.84 toolcall_end)", () => {
	it("summarizes a tool call with its friendly argument key", () => {
		const raw = {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { type: "toolCall", name: "bash", arguments: { command: "ls -la", cwd: "/tmp" } },
			},
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "tool_call", activity: { kind: "tool", name: "bash", args: "ls -la" } },
		]);
	});

	it("summarizes a tool call with JSON when no friendly key exists", () => {
		const raw = {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { type: "toolCall", name: "Agent", arguments: { prompt: "do it" } },
			},
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "tool_call", activity: { kind: "tool", name: "Agent", args: '{"prompt":"do it"}' } },
		]);
	});

	it("carries the tool call id", () => {
		const raw = {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { type: "toolCall", name: "bash", arguments: { command: "ls" }, id: "abc123" },
			},
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "tool_call", activity: { kind: "tool", name: "bash", args: "ls", id: "abc123" } },
		]);
	});

	it("truncates long JSON summaries", () => {
		const raw = {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { type: "toolCall", name: "bash", arguments: { other: "x".repeat(120) } },
			},
		};
		const events = interpretEvent(raw);
		assert.equal(events.length, 1);
		const ev = events[0] as Extract<AgentEvent, { type: "tool_call" }>;
		assert.ok(ev.activity.args.length <= 80 + 1, "summary truncated");
		assert.ok(ev.activity.args.endsWith("\u2026"));
	});

	it("ignores toolcall_end without a name, and unrelated updates", () => {
		assert.deepEqual(
			expect({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCall: { arguments: {} } } }),
			[],
		);
		assert.deepEqual(expect({ type: "message_update", assistantMessageEvent: {} }), []);
		assert.deepEqual(expect({ type: "message_update" }), []);
	});

	it("passes multibyte text through unchanged (UTF-8 integrity)", () => {
		assert.deepEqual(
			expect({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已读文件" } }),
			[{ type: "text_delta", delta: "已读文件" }],
		);
	});
});

describe("interpretEvent — agent_end", () => {
	it("extracts the API error from the last assistant message", () => {
		const raw = {
			type: "agent_end",
			messages: [
				{ role: "user", content: [] },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limited" },
			],
		};
		assert.deepEqual(interpretEvent(raw), [{ type: "agent_failed", error: "429 Rate limited" }]);
	});

	it("falls back to a generic message when the error is missing", () => {
		const raw = {
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "error" }],
		};
		assert.deepEqual(interpretEvent(raw), [{ type: "agent_failed", error: "Agent model API error" }]);
	});

	it("ignores agent_end without an error stop reason", () => {
		const raw = {
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "completed" }],
		};
		assert.deepEqual(interpretEvent(raw), []);
	});

	it("ignores agent_end that pi will transparently retry (willRetry)", () => {
		// The first agent_end of a retried turn carries the error AND willRetry:
		// true — it is not a failure, the final agent_end decides. Skipping it
		// keeps the stale error out of agentError (which has no reset path).
		const raw = {
			type: "agent_end",
			willRetry: true,
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limited" }],
		};
		assert.deepEqual(interpretEvent(raw), []);
	});
});

describe("interpretEvent — extension_ui_request (in-tree messages)", () => {
	it("parses an agent_send payload under the reserved status key", () => {
		assert.deepEqual(
			interpretEvent({
				type: "extension_ui_request",
				id: "u1",
				method: "setStatus",
				statusKey: MSG_STATUS_KEY,
				statusText: JSON.stringify({ to: "@parent", from: "a2", message: "need help" }),
			}),
			[{ type: "agent_msg", message: { to: "@parent", from: "a2", message: "need help" } }],
		);
	});

	it("defaults from to empty when omitted (sender is the root session)", () => {
		const [ev] = interpretEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: MSG_STATUS_KEY,
			statusText: JSON.stringify({ to: "a1/a1", message: "hi" }),
		});
		assert.equal(ev?.type, "agent_msg");
		if (ev?.type === "agent_msg") assert.equal(ev.message.from, "");
	});

	it("ignores non-message extension_ui_request (not our key)", () => {
		assert.deepEqual(
			interpretEvent({ type: "extension_ui_request", method: "setStatus", statusKey: "other", statusText: "x" }),
			[],
		);
		assert.deepEqual(interpretEvent({ type: "extension_ui_request", method: "notify", message: "x" }), []);
	});

	it("ignores malformed payloads (broken JSON / missing fields)", () => {
		assert.deepEqual(
			interpretEvent({
				type: "extension_ui_request",
				method: "setStatus",
				statusKey: MSG_STATUS_KEY,
				statusText: "{oops",
			}),
			[],
		);
		assert.deepEqual(
			interpretEvent({
				type: "extension_ui_request",
				method: "setStatus",
				statusKey: MSG_STATUS_KEY,
				statusText: "42",
			}),
			[],
		);
		assert.deepEqual(
			interpretEvent({
				type: "extension_ui_request",
				method: "setStatus",
				statusKey: MSG_STATUS_KEY,
				statusText: JSON.stringify({ message: "no to" }),
			}),
			[],
		);
	});
});

describe("interpretEvent — unknown events", () => {
	it("maps nothing", () => {
		assert.deepEqual(interpretEvent({ type: "extension_error" }), []);
		assert.deepEqual(interpretEvent({ type: "agent_start" }), []);
	});
});

describe("tree telemetry events (TREE_STATUS_KEY)", () => {
	const treeEvent = (statusText: unknown) =>
		interpretEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: TREE_STATUS_KEY,
			statusText: typeof statusText === "string" ? statusText : JSON.stringify(statusText),
		});

	it("parses add (running) / add (idle, resident)", () => {
		assert.deepEqual(
			treeEvent({ op: "add", id: "n1", label: "deep task", startedAt: 100, depth: 1, status: "running" }),
			[
				{
					type: "agent_tree",
					event: { op: "add", id: "n1", label: "deep task", startedAt: 100, depth: 1, status: "running" },
				},
			],
		);
		assert.deepEqual(treeEvent({ op: "add", id: "n2", label: "t", startedAt: 1, depth: 3, status: "idle" }), [
			{ type: "agent_tree", event: { op: "add", id: "n2", label: "t", startedAt: 1, depth: 3, status: "idle" } },
		]);
	});

	it("parses activity with each activity kind", () => {
		assert.deepEqual(treeEvent({ op: "activity", id: "n1", activity: { kind: "tool", name: "bash", args: "ls" } }), [
			{ type: "agent_tree", event: { op: "activity", id: "n1", activity: { kind: "tool", name: "bash", args: "ls" } } },
		]);
		assert.equal(treeEvent({ op: "activity", id: "n1", activity: { kind: "text", text: "hi" } })?.length, 1);
		assert.equal(treeEvent({ op: "activity", id: "n1", activity: { kind: "thinking", text: "" } })?.length, 1);
	});

	it("parses remove with terminal statuses only", () => {
		assert.deepEqual(treeEvent({ op: "remove", id: "n1", status: "done" }), [
			{ type: "agent_tree", event: { op: "remove", id: "n1", status: "done" } },
		]);
		assert.equal(treeEvent({ op: "remove", id: "n1", status: "failed" })?.length, 1);
		assert.equal(treeEvent({ op: "remove", id: "n1", status: "stopped" })?.length, 1);
		// non-terminal statuses are rejected
		assert.deepEqual(treeEvent({ op: "remove", id: "n1", status: "running" }), []);
		assert.deepEqual(treeEvent({ op: "remove", id: "n1", status: "idle" }), []);
	});

	it("rejects malformed payloads (bad op, missing fields, bad json, bad activity)", () => {
		assert.deepEqual(treeEvent({ op: "nope", id: "n1" }), []);
		assert.deepEqual(treeEvent({ op: "add", id: "", label: "t", startedAt: 1, depth: 1, status: "running" }), []);
		assert.deepEqual(treeEvent({ op: "add", label: "t", startedAt: 1, depth: 1, status: "running" }), []);
		assert.deepEqual(treeEvent({ op: "activity", id: "n1", activity: { kind: "weird" } }), []);
		assert.deepEqual(treeEvent("{not json"), []);
	});
});
