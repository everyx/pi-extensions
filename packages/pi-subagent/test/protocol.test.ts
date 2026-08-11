/**
 * Tests for the pure JSONL protocol layer (protocol.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatFrom, parseLine, routeMessage, serializeCommand } from "../protocol.js";

describe("serializeCommand", () => {
	it("serializes a prompt command as a single LF-terminated line", () => {
		const line = serializeCommand({ type: "prompt", message: "do the thing" });
		assert.equal(line, '{"type":"prompt","message":"do the thing"}\n');
	});

	it("serializes a prompt with streamingBehavior (in-tree delivery)", () => {
		const line = serializeCommand({ type: "prompt", message: "m", streamingBehavior: "steer" });
		const parsed = JSON.parse(line);
		assert.equal(parsed.streamingBehavior, "steer");
	});

	it("escapes JSON inside the message (quotes, newlines)", () => {
		const line = serializeCommand({ type: "prompt", message: 'say "hi"\nnext' });
		const parsed = JSON.parse(line);
		assert.equal(parsed.message, 'say "hi"\nnext');
	});
});

describe("parseLine — responses", () => {
	it("parses a successful response with id", () => {
		const parsed = parseLine('{"id":"a1","type":"response","command":"prompt","success":true}');
		assert.equal(parsed?.kind, "response");
		if (parsed?.kind === "response") {
			assert.equal(parsed.response.id, "a1");
			assert.equal(parsed.response.success, true);
			assert.equal(parsed.response.command, "prompt");
		}
	});

	it("parses a failed response with error message", () => {
		const parsed = parseLine('{"id":"a1","type":"response","command":"prompt","success":false,"error":"boom"}');
		assert.equal(parsed?.kind, "response");
		if (parsed?.kind === "response") {
			assert.equal(parsed.response.success, false);
			if (!parsed.response.success) assert.equal(parsed.response.error, "boom");
		}
	});

	it("parses a response with data payload (get_last_assistant_text)", () => {
		const parsed = parseLine(
			'{"id":"a1","type":"response","command":"get_last_assistant_text","success":true,"data":{"text":"final answer"}}',
		);
		assert.equal(parsed?.kind, "response");
		if (parsed?.kind === "response" && parsed.response.success) {
			const data = parsed.response.data as { text?: string } | undefined;
			assert.equal(data?.text, "final answer");
		}
	});

	it("rejects a response without a success field", () => {
		assert.equal(parseLine('{"id":"a1","type":"response","command":"prompt"}'), null);
	});

	it("rejects a response without a command field", () => {
		assert.equal(parseLine('{"id":"a1","type":"response","success":true}'), null);
	});
});

describe("parseLine — events", () => {
	it("parses an agent_settled event", () => {
		const parsed = parseLine('{"type":"agent_settled"}');
		assert.equal(parsed?.kind, "event");
		if (parsed?.kind === "event") assert.equal(parsed.event.type, "agent_settled");
	});

	it("parses a message_update event", () => {
		const parsed = parseLine('{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}');
		assert.equal(parsed?.kind, "event");
		if (parsed?.kind === "event") assert.equal(parsed.event.type, "message_update");
	});

	it("parses an extension_error event", () => {
		const parsed = parseLine('{"type":"extension_error","extensionPath":"x","error":"y"}');
		assert.equal(parsed?.kind, "event");
		if (parsed?.kind === "event") assert.equal(parsed.event.type, "extension_error");
	});
});

describe("parseLine — garbage", () => {
	it("returns null for empty lines", () => {
		assert.equal(parseLine(""), null);
		assert.equal(parseLine("   "), null);
	});

	it("returns null for unparseable JSON", () => {
		assert.equal(parseLine("not json"), null);
	});

	it("returns null for non-object JSON", () => {
		assert.equal(parseLine('"str"'), null);
		assert.equal(parseLine("42"), null);
	});

	it("returns null for objects without a type field", () => {
		assert.equal(parseLine('{"foo":1}'), null);
	});

	it("ignores trailing whitespace on a line", () => {
		const parsed = parseLine('{"type":"agent_settled"}  \r');
		assert.equal(parsed?.kind, "event");
	});
});

describe("routeMessage — in-tree routing (per-hop, O(1))", () => {
	const msg = (to: string, from = "a1") => ({ to, from, message: "hello" });

	it("@parent routes to the parent when one exists", () => {
		assert.deepEqual(routeMessage(msg("@parent"), ["a2"], true), { kind: "parent", message: msg("@parent") });
	});

	it("@parent errors at the root session (no parent)", () => {
		const d = routeMessage(msg("@parent", ""), ["a1"], false);
		assert.equal(d.kind, "error");
	});

	it("exact direct-child id delivers to that child", () => {
		assert.deepEqual(routeMessage(msg("a2"), ["a2", "a3"], false), {
			kind: "child",
			childId: "a2",
			message: msg("a2"),
		});
	});

	it("descendant path delivers via the direct child prefix", () => {
		const d = routeMessage(msg("a2/a2-1"), ["a2"], false);
		assert.deepEqual(d, { kind: "child", childId: "a2", message: msg("a2/a2-1") });
	});

	it("a child whose id is a prefix of another does not shadow (slash boundary)", () => {
		// "a21" must not match child "a2" — only "a2/..." does.
		const d = routeMessage(msg("a21"), ["a2"], false);
		assert.equal(d.kind, "error");
	});

	it("unknown target uplinks when a parent exists", () => {
		assert.deepEqual(routeMessage(msg("zzz"), ["a2"], true), { kind: "uplink", message: msg("zzz") });
	});

	it("unknown target errors at the root (no parent, no child)", () => {
		const d = routeMessage(msg("zzz", ""), ["a2"], false);
		assert.equal(d.kind, "error");
		if (d.kind === "error") assert.match(d.reason, /zzz/);
	});
});

describe("formatFrom — LLM-visible sender marker", () => {
	it("prefixes the sender id (empty for root)", () => {
		assert.equal(formatFrom("a1"), "[from a1] ");
		assert.equal(formatFrom(""), "");
	});
});
