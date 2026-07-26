/**
 * Tests for event stream parsing (src/events.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrintLine, streamToLines } from "../src/events.js";

describe("parsePrintLine — text_delta", () => {
	it("returns delta event for a text_delta message", () => {
		const evt = parsePrintLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
		);
		assert.equal(evt?.kind, "delta");
		if (evt?.kind === "delta") assert.equal(evt.text, "Hello ");
	});

	it("accumulates successive deltas in caller", () => {
		const line1 = parsePrintLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
		);
		const line2 = parsePrintLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "World" } }),
		);
		assert.equal(line1?.kind === "delta" ? line1.text : "", "Hello ");
		assert.equal(line2?.kind === "delta" ? line2.text : "", "World");
	});
});

describe("parsePrintLine — agent_end", () => {
	it("returns error event when stopReason is error", () => {
		const line = JSON.stringify({
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "401 CreditsError: Insufficient balance.",
				},
			],
		});
		const evt = parsePrintLine(line);
		assert.equal(evt?.kind, "error");
		if (evt?.kind === "error") assert.equal(evt.message, "401 CreditsError: Insufficient balance.");
	});

	it("returns error with fallback message when errorMessage is missing", () => {
		const line = JSON.stringify({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "error" }],
		});
		const evt = parsePrintLine(line);
		assert.equal(evt?.kind, "error");
		if (evt?.kind === "error") assert.equal(evt.message, "API error (no details)");
	});

	it("returns final event with last assistant text", () => {
		const line = JSON.stringify({
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "text", text: "the answer" }] },
			],
		});
		const evt = parsePrintLine(line);
		assert.equal(evt?.kind, "final");
		if (evt?.kind === "final") assert.equal(evt.text, "the answer");
	});

	it("returns final with empty string if no assistant message", () => {
		const line = JSON.stringify({ type: "agent_end", messages: [] });
		const evt = parsePrintLine(line);
		assert.equal(evt?.kind, "done");
	});

	it("prioritises last non‑empty assistant message", () => {
		const line = JSON.stringify({
			type: "agent_end",
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "short" }] },
				{ role: "assistant", content: [{ type: "text", text: "longer answer" }] },
			],
		});
		const evt = parsePrintLine(line);
		assert.equal(evt?.kind, "final");
		if (evt?.kind === "final") assert.equal(evt.text, "longer answer");
	});

	it("returns done for agent_end with no messages field", () => {
		const evt = parsePrintLine(JSON.stringify({ type: "agent_end" }));
		assert.equal(evt?.kind, "done");
	});
});

describe("parsePrintLine — noise", () => {
	it("ignores empty lines", () => {
		assert.equal(parsePrintLine(""), null);
		assert.equal(parsePrintLine("  "), null);
	});

	it("ignores non‑JSON lines", () => {
		assert.equal(parsePrintLine("just some text"), null);
	});

	it("ignores unknown event types", () => {
		assert.equal(parsePrintLine(JSON.stringify({ type: "unknown_event" })), null);
	});

	it("ignores agent_settled", () => {
		assert.equal(parsePrintLine(JSON.stringify({ type: "agent_settled" })), null);
	});
});

describe("streamToLines — async line demux", () => {
	it("splits chunks into lines, delivering as they arrive", async () => {
		const s = streamToLines();
		const collected: string[] = [];

		// Consume concurrently
		const consumer = (async () => {
			for await (const line of s.lines) {
				collected.push(line);
			}
		})();

		s.push("line1\nline2\n");
		s.push("line3\n");
		s.close();

		await consumer;
		assert.deepEqual(collected, ["line1", "line2", "line3"]);
	});

	it("handles partial last line (no trailing newline)", async () => {
		const s = streamToLines();
		const collected: string[] = [];

		const consumer = (async () => {
			for await (const line of s.lines) {
				collected.push(line);
			}
		})();

		s.push("line1\nline2");
		s.close();

		await consumer;
		assert.deepEqual(collected, ["line1", "line2"]);
	});

	it("handles chunk boundaries mid‑line", async () => {
		const s = streamToLines();
		const collected: string[] = [];

		const consumer = (async () => {
			for await (const line of s.lines) {
				collected.push(line);
			}
		})();

		s.push("li");
		s.push("ne1\nline");
		s.push("2\nli");
		s.push("ne3");
		s.close();

		await consumer;
		assert.deepEqual(collected, ["line1", "line2", "line3"]);
	});

	it("empty stream yields nothing", async () => {
		const s = streamToLines();
		const collected: string[] = [];

		const consumer = (async () => {
			for await (const line of s.lines) {
				collected.push(line);
			}
		})();

		s.close();
		await consumer;
		assert.deepEqual(collected, []);
	});
});
