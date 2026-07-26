/**
 * Tests for mode parsing (src/modes.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMode } from "../src/modes.js";

describe("parseMode — print mode (non‑interactive, default)", () => {
	it("task alone → print, non‑interactive by default", () => {
		const m = parseMode({ task: "analyze auth" });
		assert.equal(m.kind, "print");
		if (m.kind === "print") {
			assert.equal(m.task, "analyze auth");
			assert.equal(m.model, undefined);
			assert.equal(m.tools, undefined);
		}
	});

	it("task with model → print with model", () => {
		const m = parseMode({ task: "go deep", model: "claude-sonnet-4" });
		assert.equal(m.kind, "print");
		if (m.kind === "print") {
			assert.equal(m.task, "go deep");
			assert.equal(m.model, "claude-sonnet-4");
		}
	});

	it("task with tools → print with tools", () => {
		const m = parseMode({ task: "find stuff", tools: ["bash", "read"] });
		assert.equal(m.kind, "print");
		if (m.kind === "print") {
			assert.deepEqual(m.tools, ["bash", "read"]);
		}
	});

	it("trims whitespace from task", () => {
		const m = parseMode({ task: "   do it   " });
		assert.equal(m.kind, "print");
		if (m.kind === "print") {
			assert.equal(m.task, "do it");
		}
	});
});

describe("parseMode — interactive mode", () => {
	it("task + interactive → interactive", () => {
		const m = parseMode({ task: "refactor module", interactive: true });
		assert.equal(m.kind, "interactive");
		if (m.kind === "interactive") {
			assert.equal(m.task, "refactor module");
			assert.equal(m.model, undefined);
		}
	});

	it("interactive with model and tools", () => {
		const m = parseMode({ task: "deep dive", interactive: true, model: "sonnet", tools: ["bash"] });
		assert.equal(m.kind, "interactive");
		if (m.kind === "interactive") {
			assert.equal(m.task, "deep dive");
			assert.equal(m.model, "sonnet");
			assert.deepEqual(m.tools, ["bash"]);
		}
	});
});

describe("parseMode — battle mode", () => {
	it("session + task → battle", () => {
		const m = parseMode({ session: "pi-sub-abc", task: "go further" });
		assert.equal(m.kind, "battle");
		if (m.kind === "battle") {
			assert.equal(m.session, "pi-sub-abc");
			assert.equal(m.task, "go further");
		}
	});

	it("trims session and task", () => {
		const m = parseMode({ session: "  pi-sub-abc  ", task: "  deeper  " });
		assert.equal(m.kind, "battle");
		if (m.kind === "battle") {
			assert.equal(m.session, "pi-sub-abc");
			assert.equal(m.task, "deeper");
		}
	});
});

describe("parseMode — close mode", () => {
	it("session + close → close", () => {
		const m = parseMode({ session: "pi-sub-abc", close: true });
		assert.equal(m.kind, "close");
		if (m.kind === "close") {
			assert.equal(m.session, "pi-sub-abc");
		}
	});
});

describe("parseMode — error mode", () => {
	it("empty params → error", () => {
		const m = parseMode({});
		assert.equal(m.kind, "error");
		if (m.kind === "error") assert(m.message.length > 0);
	});

	it("session only → error", () => {
		const m = parseMode({ session: "pi-sub-abc" });
		assert.equal(m.kind, "error");
		if (m.kind === "error") assert(m.message.includes("session"));
	});

	it("close without session → error", () => {
		const m = parseMode({ close: true });
		assert.equal(m.kind, "error");
		if (m.kind === "error") assert(m.message.includes("close"));
	});

	it("close + task → error", () => {
		const m = parseMode({ session: "s", close: true, task: "nope" });
		assert.equal(m.kind, "error");
		if (m.kind === "error") assert(m.message.includes("close"));
	});

	it("session + close + task (all three) → error", () => {
		const m = parseMode({ session: "s", close: true, task: "oops" });
		assert.equal(m.kind, "error");
	});

	it("close + task but no session → error", () => {
		const m = parseMode({ close: true, task: "x" });
		assert.equal(m.kind, "error");
	});
});
