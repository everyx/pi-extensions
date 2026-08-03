import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAgentResult } from "../render.js";

/**
 * Fake theme: marks styling with plain tags instead of ANSI so the test can
 * assert on visible content. The pi-tui Text wrapping underneath still
 * measures real widths (it strips actual ANSI; tags count as plain chars,
 * which only makes wrapping more conservative).
 */
const theme = new Proxy(
	{},
	{
		get:
			(_, key) =>
			(...args: string[]) =>
				key === "fg" || key === "bg"
					? `<${args[0]}>${args[1]}</${args[0]}>`
					: key === "bold" || key === "italic"
						? `[${key}]${args[0]}[/${key}]`
						: String(key),
	},
) as never;

const context = {
	state: {},
	invalidate: () => {},
	executionStarted: true,
	isError: false,
} as never;

function render(component: unknown, width: number): string[] {
	return (component as { render(w: number): string[] }).render(width);
}

test("collapsed card wraps a long prompt instead of overflowing", () => {
	const longTask = `${"长".repeat(200)} ${"x".repeat(200)}`; // 400+ visible columns
	const cmp = renderAgentResult(
		{
			content: [{ type: "text", text: "" }],
			details: { task: longTask, startedAt: 0, endedAt: 0 },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 80);
	// 400 visible columns must wrap into many lines, not one overflowing line.
	assert.ok(lines.length > 5, `expected wrapped input, got ${lines.length} lines`);
	for (const line of lines) {
		const visible = line.replace(/<[^>]+>/g, "").replace(/\[[a-z]+\]|\[\/[a-z]+\]/g, "");
		assert.ok(visible.length <= 80, `line overflows 80 cols: ${visible.slice(0, 60)}…`);
	}
});

test("expanded card also fits the width (Text wraps long output)", () => {
	const longOutput = `${"y".repeat(300)}\n${"长".repeat(150)}`;
	const cmp = renderAgentResult(
		{
			content: [{ type: "text", text: longOutput }],
			details: { task: "short", startedAt: 0, endedAt: 0 },
		},
		{ expanded: true, isPartial: false },
		theme,
		context,
	);
	for (const line of render(cmp, 80)) {
		const visible = line.replace(/<[^>]+>/g, "").replace(/\[[a-z]+\]|\[\/[a-z]+\]/g, "");
		assert.ok(visible.length <= 80, `line overflows 80 cols: ${visible.slice(0, 60)}…`);
	}
});
