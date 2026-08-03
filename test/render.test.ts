import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderAgentResult } from "../render.js";

// Fold hints render through keyHint, which reads the real global theme.
initTheme("dark");

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

/** Strip real ANSI (keyHint) + fake-theme tags + trailing width padding. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function strip(s: string): string {
	return s
		.replace(ANSI_RE, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\[[a-z]+\]|\[\/[a-z]+\]/g, "")
		.trim();
}

test("collapsed card folds a long prompt to the tail preview instead of overflowing", () => {
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
	// 400+ columns wrap into many lines, then fold to blank + hint + tail 5 +
	// footer — the prompt rides the stream (not pinned), nothing overflows.
	assert.ok(lines.length <= 10, `expected folded preview, got ${lines.length} lines`);
	assert.ok(
		lines.some((l) => l.includes("earlier lines")),
		"expected fold hint",
	);
	for (const line of lines) {
		assert.ok(strip(line).length <= 80, `line overflows 80 cols: ${strip(line).slice(0, 60)}…`);
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
		assert.ok(strip(line).length <= 80, `line overflows 80 cols: ${strip(line).slice(0, 60)}…`);
	}
});

test("collapsed folds the prompt away once output fills the preview", () => {
	const task = "prompt line";
	const output = Array.from({ length: 10 }, (_, i) => `out ${i}`).join("\n");
	const cmp = renderAgentResult(
		{
			content: [{ type: "text", text: output }],
			details: { task, startedAt: 0, endedAt: 0 },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 80).map(strip);
	// Stream is prompt + blank + 10 outputs = 12 rows; the tail 5 survive.
	assert.ok(
		lines.some((l) => l.includes("7 earlier lines")),
		"hint counts prompt + blank + early output",
	);
	assert.ok(
		lines.some((l) => l.includes("out 9")),
		"latest output visible",
	);
	assert.ok(!lines.some((l) => l.includes("out 0")), "early output folded");
	assert.ok(!lines.some((l) => l.includes("prompt line")), "prompt folded away, not pinned");
});

test("collapsed keeps the whole stream when it fits", () => {
	const task = "prompt line";
	const output = ["out 1", "out 2", "out 3"].join("\n");
	const cmp = renderAgentResult(
		{
			content: [{ type: "text", text: output }],
			details: { task, startedAt: 0, endedAt: 0 },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 80).map(strip);
	// 5 rows fit: no hint, prompt visible at the head of the stream.
	assert.ok(lines.includes("prompt line"), "prompt visible when the stream fits");
	assert.ok(lines.includes("out 1"), "first output visible");
	assert.ok(lines.includes("out 3"), "last output visible");
	assert.ok(!lines.some((l) => l.includes("earlier lines")), "no hint when nothing is folded");
});
