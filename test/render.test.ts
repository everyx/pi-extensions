import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderAgentControlResult, renderAgentResult, renderNotification, safeTitle } from "../render.js";

// Fold hints render through keyHint, which reads the real global theme.
initTheme("dark");

/**
 * Fake theme: emits real ANSI codes so pi-tui's Text measures true visual
 * widths (it strips ANSI) — asserting on single lines stays reliable. Tags
 * would inflate line widths and make Text wrap mid-phrase.
 */
const theme = new Proxy(
	{},
	{
		get:
			(_, key) =>
			(...args: string[]) =>
				key === "fg" || key === "bg"
					? `\x1b[31m${args[1]}\x1b[0m`
					: key === "bold"
						? `\x1b[1m${args[0]}\x1b[0m`
						: key === "italic"
							? `\x1b[3m${args[0]}\x1b[0m`
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

/**
 * Rendered text joined across lines — fake-theme tags inflate line widths and
 * make Text wrap mid-phrase, so assertions match on the joined text instead of
 * single lines.
 */
function renderText(component: unknown, width: number): string {
	return render(component, width).map(strip).join("\n");
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
			details: { task, startedAt: 0, endedAt: 0, events: [{ kind: "text", text: output }] },
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
			details: { task, startedAt: 0, endedAt: 0, events: [{ kind: "text", text: output }] },
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

// ── Background start: single status line, no agent id on the card ──

test("background start animates starting, then settles on started", () => {
	const ctx = {
		state: { stopFrame: 0, interval: undefined as ReturnType<typeof setInterval> | undefined },
		invalidate: () => {},
		executionStarted: true,
		isError: false,
	};
	try {
		const partial = renderAgentResult(
			{
				content: [{ type: "text", text: "Starting x…" }],
				details: { runInBackground: true, title: "research db schema" },
			},
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		);
		const running = renderText(partial, 120);
		assert.ok(running.includes("research db schema"), "title on the line");
		assert.ok(running.includes("starting…"), "starting state");
		assert.ok(!running.includes("agent a1"), "no id on the card");

		const done = renderAgentResult(
			{
				content: [{ type: "text", text: "Started background agent a1. Completion arrives as a notification." }],
				details: { runInBackground: true, title: "research db schema", startedAt: 0 },
			},
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const settled = renderText(done, 120);
		assert.ok(settled.includes("started"), "started state");
		// The id stays in the LLM content, never on the card.
		assert.ok(!settled.includes("background agent a1"), "no id on the card");
	} finally {
		if (ctx.state.interval) clearInterval(ctx.state.interval);
	}
});

test("background start failure renders start failed with the reason", () => {
	const cmp = renderAgentResult(
		{
			content: [{ type: "text", text: "model not found" }],
			details: { runInBackground: true, title: "research db schema", error: "model not found" },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const text = renderText(cmp, 120);
	assert.ok(text.includes('✗ Agent "research db schema" start failed'), "failed state line with icon + quoted title");
	assert.ok(text.includes("model not found"), "reason on its own line");
});

// ── AgentControl: status lines (no card shell) ──

test("stop animates stopping then settles on stopped", () => {
	const ctx = {
		state: { stopFrame: 0, interval: undefined as ReturnType<typeof setInterval> | undefined },
		invalidate: () => {},
		executionStarted: true,
		isError: false,
	};
	try {
		const partial = renderAgentControlResult(
			{ content: [{ type: "text", text: "Stopping…" }], details: { action: "stop", title: "slow query probe" } },
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		);
		const running = renderText(partial, 120);
		assert.ok(running.includes("stopping…"), "stopping state");

		const done = renderAgentControlResult(
			{
				content: [{ type: "text", text: "Stopped agent a2." }],
				details: { action: "stop", title: "slow query probe" },
			},
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const settled = renderText(done, 120);
		assert.ok(settled.includes("stopped"), "stopped state");
	} finally {
		if (ctx.state.interval) clearInterval(ctx.state.interval);
	}
});

test("steer renders the status line plus the message as plain content", () => {
	const cmp = renderAgentControlResult(
		{
			content: [{ type: "text", text: 'Steered agent a1: "focus on orders".' }],
			details: { action: "steer", title: "research db schema", message: "重点看 orders 表的索引和慢查询" },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 120).map(strip);
	assert.ok(
		lines.some((l) => l.includes("steered")),
		"steered state",
	);
	assert.ok(
		lines.some((l) => l.includes("重点看 orders 表的索引和慢查询")),
		"message as a content line",
	);
	assert.ok(!lines.some((l) => l.includes("│ 重点看")), "no quote border");
});

test("steer shows the full multi-line message, not a first-line preview", () => {
	const message = "第一行指令\n第二行补充说明\n第三行收尾";
	const cmp = renderAgentControlResult(
		{
			content: [{ type: "text", text: "Steered." }],
			details: { action: "steer", title: "probe", message },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 120).map(strip);
	assert.ok(
		lines.some((l) => l.includes("第二行补充说明")),
		"second line shown",
	);
	assert.ok(
		lines.some((l) => l.includes("第三行收尾")),
		"third line shown",
	);
});

test("control failures keep the status-line shape with error color", () => {
	const cmp = renderAgentControlResult(
		{
			content: [{ type: "text", text: "Agent a2 not found." }],
			details: { action: "steer", error: "agent a2 not found or already finished" },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 120).map(strip);
	assert.ok(
		lines.some((l) => l.includes("steer failed")),
		"failed state with reason",
	);
});

test("control failures show the full error, never truncated", () => {
	const longError = `模型 "no-such-model-xyz-very-long-name-\u2026" not available in the registry. `
		.concat("This is a deliberately long error message that must survive rendering ".repeat(3))
		.trim();
	const cmp = renderAgentControlResult(
		{
			content: [{ type: "text", text: longError }],
			details: { action: "stop", title: "probe", error: longError },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	const lines = render(cmp, 120).map(strip);
	assert.ok(
		lines.some((l) => l.includes("survive rendering")),
		"full error text visible",
	);
});

test("a stop that fails mid-animation clears the spinner interval", () => {
	// Partial stop frame starts the 100ms invalidate interval…
	renderAgentControlResult(
		{ content: [{ type: "text", text: "Stopping…" }], details: { action: "stop", title: "probe" } },
		{ expanded: false, isPartial: true },
		theme,
		context,
	);
	const st = (context as { state: { interval?: unknown } }).state;
	assert.ok(st.interval, "spinner interval started");
	// …and a failed stop (isError, details.error) must stop it.
	renderAgentControlResult(
		{
			content: [{ type: "text", text: "agent died" }],
			details: { action: "stop", title: "probe", error: "agent died" },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	assert.equal(st.interval, undefined, "interval cleared on failed stop");
});

// ── Notification card: status icon distinguishes it from the tool card ──

test("notification header carries the status icon", () => {
	const ok = renderNotification(
		{
			details: {
				status: "completed",
				agent_id: "a1",
				title: "research db schema",
				result: "found 5 tables",
				usage: { durationMs: 27500, tokens: 1250, toolUses: 3 },
			},
		},
		{ expanded: false },
		theme,
	);
	assert.ok(renderText(ok, 120).includes('✓ Agent "research db schema"'), "completed icon");

	const failed = renderNotification(
		{
			details: {
				status: "failed",
				agent_id: "a1",
				title: "research db schema",
				result: "partial",
				usage: { durationMs: 12000, tokens: 1100, toolUses: 2 },
			},
		},
		{ expanded: false },
		theme,
	);
	assert.ok(renderText(failed, 120).includes('✗ Agent "research db schema" failed'), "failed icon + word");

	const stopped = renderNotification(
		{
			details: {
				status: "stopped",
				agent_id: "a1",
				title: "slow query probe",
				usage: { durationMs: 3200, tokens: 0, toolUses: 0 },
			},
		},
		{ expanded: false },
		theme,
	);
	assert.ok(renderText(stopped, 120).includes('■ Agent "slow query probe" stopped'), "stopped icon + word");
});

// ── context truncation warning (bash parity) ──

test("foreground card warns about context truncation below the body", () => {
	const text = Array.from({ length: 7 }, (_, i) => `line ${i}`).join("\n");
	const out = renderText(
		renderAgentResult(
			{
				content: [{ type: "text", text }],
				details: {
					task: "probe",
					startedAt: 0,
					endedAt: 100,
					sessionPath: "/tmp/sess",
					truncation: {
						truncated: true,
						truncatedBy: "lines",
						outputLines: 42,
						totalLines: 5000,
						maxLines: 2000,
						maxBytes: 51200,
					},
					events: [{ kind: "text", text }],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		120,
	);
	assert.ok(out.includes("[Truncated: showing 42 of 5000 lines]"), "lines variant");
	// warning sits between body and footer
	const idxWarn = out.indexOf("Truncated:");
	const idxSess = out.indexOf("session: /tmp/sess");
	assert.ok(idxWarn > -1 && idxSess > idxWarn, "warning above footer");
});

test("notification warns with the bytes variant when truncation hit the size cap", () => {
	const out = renderText(
		renderNotification(
			{
				details: {
					status: "completed",
					agent_id: "a1",
					title: "probe",
					result: "x",
					sessionPath: "/tmp/sess",
					truncation: {
						truncated: true,
						truncatedBy: "bytes",
						outputLines: 42,
						totalLines: 5000,
						maxLines: 2000,
						maxBytes: 51200,
					},
				},
			},
			{ expanded: false },
			theme,
		),
		120,
	);
	assert.ok(out.includes("Truncated: 42 lines shown (50.0KB limit)"), "bytes variant");
});

test("no truncation warning when details lack truncation", () => {
	const out = renderText(
		renderAgentResult(
			{
				content: [{ type: "text", text: "fine" }],
				details: {
					task: "probe",
					startedAt: 0,
					endedAt: 100,
					sessionPath: "/tmp/sess",
					events: [{ kind: "text", text: "fine" }],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		),
		120,
	);
	assert.ok(!out.includes("Truncated:"), "no warning without truncation");
});

// ── safeTitle (title rendered safe for a single quoted line) ──

test("safeTitle flattens newlines and neutralizes embedded quotes", () => {
	assert.equal(safeTitle('research "db" schema'), "research 'db' schema");
	assert.equal(safeTitle("line1\nline2\t tab"), "line1 line2  tab");
	assert.equal(safeTitle("  padded  "), "padded");
	assert.equal(safeTitle(undefined), "(untitled)");
});

test("safeTitle caps long titles with a trailing ellipsis", () => {
	const long = "a".repeat(100);
	const out = safeTitle(long, 40);
	assert.equal(out.length, 40);
	assert.equal(out.endsWith("…"), true);
});
