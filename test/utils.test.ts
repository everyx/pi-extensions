/**
 * Tests for shared utilities (src/utils.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastAssistantText } from "../src/utils.js";

/** Minimal mock of ExtensionContext with a controlled branch. */
function mockContext(entries: unknown[]): { sessionManager: { getBranch: () => unknown[] } } {
	return {
		sessionManager: {
			getBranch: () => entries,
		},
	};
}

describe("lastAssistantText", () => {
	it("returns empty string for empty branch", () => {
		const ctx = mockContext([]);
		assert.equal(lastAssistantText(ctx as never), "");
	});

	it("returns empty string when no assistant message exists", () => {
		const ctx = mockContext([{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]);
		assert.equal(lastAssistantText(ctx as never), "");
	});

	it("returns text from last assistant message", () => {
		const ctx = mockContext([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } },
		]);
		assert.equal(lastAssistantText(ctx as never), "the answer");
	});

	it("prefers last non-empty assistant message over earlier ones", () => {
		const ctx = mockContext([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "new" }] } },
		]);
		assert.equal(lastAssistantText(ctx as never), "new");
	});

	it("skips assistant messages with only thinking (no text)", () => {
		const ctx = mockContext([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "thinking text..." }],
				},
			},
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "real answer" }] } },
		]);
		assert.equal(lastAssistantText(ctx as never), "real answer");
	});

	it("joins multiple text parts", () => {
		const ctx = mockContext([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "part1" },
						{ type: "text", text: "part2" },
					],
				},
			},
		]);
		assert.equal(lastAssistantText(ctx as never), "part1\npart2");
	});

	it("returns empty string when assistant message has empty text", () => {
		const ctx = mockContext([
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "" }] },
			},
		]);
		assert.equal(lastAssistantText(ctx as never), "");
	});

	it("returns empty string when assistant message has no content", () => {
		const ctx = mockContext([{ type: "message", message: { role: "assistant", content: [] } }]);
		assert.equal(lastAssistantText(ctx as never), "");
	});

	it("returns empty string when entry is not a message type", () => {
		const ctx = mockContext([
			{ type: "model_change" },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		]);
		assert.equal(lastAssistantText(ctx as never), "answer");
	});
});
