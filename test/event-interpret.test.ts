/**
 * Tests for the raw RpcEvent → AgentEvent interpretation layer
 * (event-interpret.ts).
 *
 * interpretEvent maps pi's rpc protocol vocabulary (message_update content
 * arrays, assistantMessageEvent deltas, agent_end messages) onto our domain
 * vocabulary. It is a pure function — fed raw event shapes exactly as they
 * arrive off the wire, without any FakeClient indirection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AgentEvent, interpretEvent } from "../event-interpret.js";

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

	it("ignores non-delta assistant message events", () => {
		assert.deepEqual(expect({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }), []);
	});
});

describe("interpretEvent — message_update activity", () => {
	it("extracts thinking from the last content part", () => {
		const raw = {
			type: "message_update",
			message: {
				content: [
					{ type: "text", text: "old" },
					{ type: "thinking", thinking: "let me think" },
				],
			},
		};
		assert.deepEqual(interpretEvent(raw), [{ type: "activity", activity: { kind: "thinking", text: "let me think" } }]);
	});

	it("extracts text from the last content part", () => {
		const raw = {
			type: "message_update",
			message: { content: [{ type: "text", text: "writing…" }] },
		};
		assert.deepEqual(interpretEvent(raw), [{ type: "activity", activity: { kind: "text", text: "writing…" } }]);
	});

	it("summarizes a tool call with its friendly argument key", () => {
		const raw = {
			type: "message_update",
			message: { content: [{ type: "toolCall", name: "bash", arguments: { command: "ls -la", cwd: "/tmp" } }] },
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "activity", activity: { kind: "tool", name: "bash", args: "ls -la" } },
		]);
	});

	it("summarizes a tool call with JSON when no friendly key exists", () => {
		const raw = {
			type: "message_update",
			message: { content: [{ type: "toolCall", name: "Agent", arguments: { prompt: "do it" } }] },
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "activity", activity: { kind: "tool", name: "Agent", args: '{"prompt":"do it"}' } },
		]);
	});

	it("truncates long JSON summaries", () => {
		const raw = {
			type: "message_update",
			message: {
				content: [
					{
						type: "toolCall",
						name: "bash",
						arguments: { other: "x".repeat(120) },
					},
				],
			},
		};
		const events = interpretEvent(raw);
		assert.equal(events.length, 1);
		const ev = events[0] as Extract<AgentEvent, { type: "activity" }>;
		const args = ev.activity.kind === "tool" ? ev.activity.args : "";
		assert.ok(args.length <= 80 + 1, "summary truncated");
		assert.ok(args.endsWith("\u2026"));
	});

	it("ignores empty content, blank thinking, and non-content updates", () => {
		assert.deepEqual(expect({ type: "message_update", message: { content: [] } }), []);
		assert.deepEqual(
			expect({ type: "message_update", message: { content: [{ type: "thinking", thinking: "  " }] } }),
			[],
		);
		assert.deepEqual(expect({ type: "message_update", message: {} }), []);
		assert.deepEqual(expect({ type: "message_update" }), []);
	});

	it("passes multibyte text through unchanged (UTF-8 integrity)", () => {
		const raw = {
			type: "message_update",
			message: { content: [{ type: "text", text: "分析 src/auth/*.ts 的鉴权逻辑…" }] },
			assistantMessageEvent: { type: "text_delta", delta: "已读文件" },
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "activity", activity: { kind: "text", text: "分析 src/auth/*.ts 的鉴权逻辑…" } },
			{ type: "text_delta", delta: "已读文件" },
		]);
	});

	it("combines activity and text_delta from one update", () => {
		const raw = {
			type: "message_update",
			message: { content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
			assistantMessageEvent: { type: "text_delta", delta: "checking…" },
		};
		assert.deepEqual(interpretEvent(raw), [
			{ type: "activity", activity: { kind: "tool", name: "read", args: "a.ts" } },
			{ type: "text_delta", delta: "checking…" },
		]);
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
});

describe("interpretEvent — unknown events", () => {
	it("maps nothing", () => {
		assert.deepEqual(interpretEvent({ type: "extension_error" }), []);
		assert.deepEqual(interpretEvent({ type: "agent_start" }), []);
	});
});
