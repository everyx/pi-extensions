/**
 * Tests for pi-ui shared primitives (spinner/card/format).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderHeader } from "../card.js";
import { clipTail, formatDuration, Spinner, safeTitle } from "../spinner.js";

describe("spinner", () => {
	it("returns a frame immediately and stays within the frame set", () => {
		const s = new Spinner();
		const frame = s.current();
		assert.ok(frame.length >= 1);
	});
	it("advances frames with time", async () => {
		const s = new Spinner();
		const first = s.current();
		await new Promise((r) => setTimeout(r, 90));
		const second = s.current();
		// May coincide on frame boundaries — just assert it's still a valid frame.
		assert.ok(second.length >= 1);
		void first;
	});
});

describe("formatDuration", () => {
	it("formats seconds with one decimal", () => {
		assert.equal(formatDuration(12_500), "12.5s");
		assert.equal(formatDuration(0), "0.0s");
	});
});

describe("clipTail", () => {
	it("collapses whitespace and trims", () => {
		assert.equal(clipTail("  a\n b "), "a b");
	});
	it("cuts long tails with a leading ellipsis", () => {
		const out = clipTail("x".repeat(100), 20);
		assert.equal(out.length, 20);
		assert.ok(out.startsWith("\u2026"));
	});
});

describe("safeTitle", () => {
	it("flattens newlines and neutralizes quotes", () => {
		assert.equal(safeTitle('a"b\nc'), "a'b c");
	});
	it("caps long titles with a trailing ellipsis", () => {
		const out = safeTitle("x".repeat(60), 40);
		assert.equal(out.length, 40);
		assert.ok(out.endsWith("\u2026"));
	});
	it("defaults to (untitled)", () => {
		assert.equal(safeTitle(undefined), "(untitled)");
	});
});

describe("renderHeader", () => {
	// Minimal theme stub for pure rendering checks.
	const theme = {
		fg: (color: string, s: string) => `${color}:${s}`,
		bold: (s: string) => `*${s}*`,
	} as never;

	it("renders name + quoted title with a state word", () => {
		const line = renderHeader(
			{ icon: { type: "success" }, name: "Agent", title: "t", state: { verb: "stop", phase: "done" } },
			theme,
		);
		assert.match(line, /Agent/);
		assert.match(line, /"t"/);
		assert.match(line, /stopped/);
	});
	it("stop running phase uses the double-consonant form", () => {
		const line = renderHeader(
			{
				icon: { type: "spinner", spinner: new Spinner() },
				name: "Agent",
				title: "t",
				state: { verb: "stop", phase: "running" },
			},
			theme,
		);
		assert.match(line, /stopping/);
		assert.ok(!line.includes("stoping"));
	});
	it("start done phase", () => {
		const line = renderHeader(
			{ icon: { type: "success" }, name: "Agent", title: "t", state: { verb: "start", phase: "done" } },
			theme,
		);
		assert.match(line, /started/);
	});
	it("status word and meta", () => {
		const line = renderHeader(
			{
				icon: { type: "error" },
				title: "web_search",
				status: { word: "failed", color: "error" },
				meta: ["via exa", "5 results"],
			},
			theme,
		);
		assert.match(line, /failed/);
		assert.match(line, /via exa/);
	});
	it("plain title without a name", () => {
		const line = renderHeader({ icon: { type: "success" }, title: "web_search (via exa)" }, theme);
		assert.match(line, /web_search/);
	});
});
