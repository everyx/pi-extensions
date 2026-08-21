import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { capPlain, structRow } from "../width.js";

describe("capPlain", () => {
	it("keeps short text as-is", () => {
		assert.equal(capPlain("hello", 10), "hello");
	});
	it("cuts long text to max columns with an ellipsis", () => {
		const out = capPlain("x".repeat(60), 40);
		assert.equal(visibleWidth(out), 40);
		assert.ok(out.endsWith("\u2026"));
	});
	it("measures CJK by terminal columns, not chars", () => {
		const out = capPlain("调".repeat(30), 20);
		assert.ok(visibleWidth(out) <= 20);
		assert.ok(out.endsWith("\u2026"));
	});
});

describe("structRow", () => {
	const styled = (s: string) => `\x1b[36m${s}\x1b[0m`;

	it("assembles prefix + content + suffix", () => {
		const out = structRow({ prefix: " ⠋ ", content: "task", suffix: " (5s)", width: 80 });
		assert.equal(out, " ⠋ task (5s)");
	});

	it("never exceeds the terminal width, however long the content", () => {
		const out = structRow({
			prefix: styled(" ⠋ "),
			content: "x".repeat(500),
			suffix: styled(" (1m 40s)"),
			width: 80,
			styleContent: styled,
		});
		assert.ok(visibleWidth(out) <= 80, `width ${visibleWidth(out)} > 80`);
	});

	it("skips ANSI codes when measuring prefix/suffix", () => {
		const plain = structRow({ prefix: " ab ", content: "c", width: 80 });
		const ansi = structRow({ prefix: styled(" ab "), content: "c", width: 80 });
		assert.equal(visibleWidth(plain), visibleWidth(ansi));
	});

	it("flattens newlines and tabs (zero-width collapse would lie about fit)", () => {
		const out = structRow({ prefix: "", content: "a\nb\tc", width: 80 });
		assert.equal(out, "a b c");
		assert.ok(!out.includes("\n"));
	});

	it("keep tail sacrifices the head for activity streams", () => {
		const out = structRow({ prefix: "", content: "0123456789".repeat(10), width: 12, keep: "tail" });
		assert.equal(visibleWidth(out), 12);
		assert.ok(out.startsWith("\u2026"));
	});

	it("degenerate width still emits a safe line", () => {
		const out = structRow({ prefix: "   ", content: "y".repeat(50), width: 2 });
		assert.ok(visibleWidth(out) <= 3 + 2);
	});
});
