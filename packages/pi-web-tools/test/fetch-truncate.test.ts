import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capMarkdown } from "../fetch/fetch.js";

describe("capMarkdown — byte-budget truncation (pi truncateHead parity)", () => {
	it("passes short text through unchanged", () => {
		const text = "# Title\n\nshort body";
		assert.equal(capMarkdown(text), text);
	});

	it("caps ASCII content at 50KB of bytes, keeping the head", () => {
		const text = `# Doc\n\n${"x".repeat(100_000)}`;
		const out = capMarkdown(text);
		assert.ok(Buffer.byteLength(out, "utf8") <= 50_000, `bytes ${Buffer.byteLength(out, "utf8")} > 50KB`);
		assert.ok(out.startsWith("# Doc"), "head must be kept");
	});

	it("caps CJK content at the same byte budget (not char count)", () => {
		// 50k CJK chars = ~150KB bytes — char slicing would blow the budget 3x.
		const text = `# 文档\n\n${"调研亮色高亮色处理方案".repeat(20_000)}`;
		const out = capMarkdown(text);
		assert.ok(Buffer.byteLength(out, "utf8") <= 50_000, `bytes ${Buffer.byteLength(out, "utf8")} > 50KB`);
		assert.ok(out.startsWith("# 文档"), "head must be kept");
	});
});
