import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { safeTitle } from "../format.js";
import { renderNotification } from "../render.js";

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
