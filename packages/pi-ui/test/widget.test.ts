/**
 * Tests for StatusWidget lifetime progress meta (`1/3`, `(1+2)/3`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Spinner } from "../spinner.js";
import { EXCERPT_INDENT, renderWidgetItemLine, StatusWidget, type WidgetItem, type WidgetRow } from "../widget.js";

/** Captures the widget's render function through a mock ui.setWidget. */
function capture(ui: { setWidget: ExtensionUIContext["setWidget"] }) {
	let render: ((width?: number) => string[]) | undefined;
	ui.setWidget = (_key, widget) => {
		render =
			typeof widget === "function"
				? (widget as unknown as (tui: unknown, th: unknown) => { render(width?: number): string[] })(
						{ requestRender: () => {} },
						theme,
					).render
				: undefined;
	};
	return () => render?.() ?? [];
}

const theme = {
	fg: (color: string, s: string) => `${color}:${s}`,
	bold: (s: string) => `*${s}*`,
	italic: (s: string) => `${s}`,
} as never;

const item = (id: string): WidgetItem => ({ id, title: `t${id}`, startedAt: 0, status: "running" });

describe("StatusWidget progress meta", () => {
	it("renders progress + live segments while items run (done 0/2 · 2 running)", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.add(item("b"));
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:\(done 0\/2 · 2 running\)/);
		w.dispose();
	});

	it("counts done removals (1/2)", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.add(item("b"));
		w.remove("a", "done");
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:\(done 1\/2 · 1 running\)/);
		w.dispose();
	});

	it("splits abnormal ends into a parenthesized, error-colored numerator", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.add(item("b"));
		w.add(item("c"));
		w.remove("a", "done");
		w.remove("b", "stopped");
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:\(done 1\/3 · 1 running · 1 stopped\)/);
		w.dispose();
	});

	it("mixes failed and stopped into one abnormal count", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.add(item("b"));
		w.add(item("c"));
		w.remove("a", "failed");
		w.remove("b", "stopped");
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:\(done 0\/3 · 1 running · error:1 failed · 1 stopped\)/);
		w.dispose();
	});

	it("does not count a removal without a result", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.add(item("b"));
		w.remove("a");
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:\(done 0\/2 · 1 running\)/);
		w.dispose();
	});

	it("resets the counters when the widget empties (dispose ends its lifetime)", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.remove("a", "done");
		assert.equal(
			lines().find((l) => l.includes("Agents")),
			undefined,
		); // empty → unregistered
		w.add(item("b")); // next batch starts a fresh lifetime
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:\(done 0\/1 · 1 running\)/);
		w.dispose();
	});

	it("swarm mode: collapses rows past maxLines into a folded counter (live first)", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents", 2);
		const lines = capture(ui);
		w.add({ id: "a", title: "ta", startedAt: 0, status: "idle" });
		w.add({ id: "b", title: "tb", startedAt: 0, status: "running" });
		w.add({ id: "c", title: "tc", startedAt: 0, status: "idle" });
		w.add({ id: "d", title: "td", startedAt: 0, status: "running" });
		const out = lines();
		// running rows shown first (b, d), idle folded into the counter line.
		assert.ok(
			out.some((l) => l.includes("tb")),
			"running row shown",
		);
		assert.ok(
			out.some((l) => l.includes("td")),
			"running row shown",
		);
		assert.ok(!out.some((l) => l.includes("ta")), "idle row folded");
		assert.ok(
			out.some((l) => l.includes("+2 more")),
			"fold counter",
		);
		assert.ok(
			out.some((l) => l.includes("2 idle")),
			"fold segments",
		);
		w.dispose();
	});

	it("no meta when the widget has no title", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext);
		const lines = capture(ui);
		w.add(item("a"));
		assert.ok(!lines().some((l) => l.includes("/")));
		w.dispose();
	});
});

describe("StatusWidget — idle rows (persistent agents)", () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("renders an idle row with a pause marker and no meta", () => {
		const lines = renderWidgetItemLine({ id: "a", title: "stay", startedAt: 0, status: "idle" }, theme, new Spinner());
		assert.ok(lines[0]);
		assert.match(lines[0] ?? "", /\u2016/); // ‖ pause marker
		assert.ok(!(lines[0] ?? "").includes("("), "no meta tail — the icon carries the state");
	});

	it("updateStatus flips a row between running and idle in place", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.updateStatus("a", "idle");
		assert.ok(
			lines().some((l) => l.includes("\u2016")),
			"row shows the pause marker after the flip",
		);
		w.updateStatus("a", "running");
		assert.ok(!lines().some((l) => l.includes("\u2016")), "row shows running again");
		w.dispose();
	});

	it("updateRows refreshes the activity excerpt in place", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		assert.ok(!lines().some((l) => l.includes("bash:")), "no excerpt yet");
		w.updateRows("a", [{ style: "tool", content: "bash: sleep 20" }]);
		assert.ok(
			lines().some((l) => l.includes("bash: sleep 20")),
			"live excerpt shows",
		);
		w.dispose();
	});

	it("idle-only rows stop the animation clock — zero periodic redraws (pi-bash parity)", async () => {
		let renders = 0;
		let widgetFactory: unknown;
		const ui = {
			setWidget: (_key: unknown, wf: unknown) => {
				widgetFactory = wf;
			},
		} as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		w.add(item("a"));
		(widgetFactory as (tui: unknown, th: unknown) => { render(): string[] })({ requestRender: () => renders++ }, theme);
		w.updateStatus("a", "idle");
		const afterIdle = renders;
		await sleep(250);
		assert.equal(renders, afterIdle, "no periodic redraws while idle (clock stopped)");
		// Waking the persistent agent resumes the animation. The event-driven
		// redraw fires immediately; only resumed clock ticks can increase the
		// counter during the sleep window — so a stale > comparison would fail.
		w.updateStatus("a", "running");
		const before = renders;
		await sleep(250);
		assert.ok(renders > before, "animation resumes when a row runs again");
		w.dispose();
	});
});

describe("StatusWidget — shared-ticker animation", () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("redraws on the unified ticker while a row runs", async () => {
		let renders = 0;
		let widgetFactory: unknown;
		const ui = {
			setWidget: (_key: unknown, wf: unknown) => {
				widgetFactory = wf;
			},
		} as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		w.add(item("a"));
		// The pi host calls the widget factory with the tui handle — capture
		// requestRender through it, like the real runtime does.
		(widgetFactory as (tui: unknown, th: unknown) => { render(): string[] })({ requestRender: () => renders++ }, theme);
		assert.equal(renders, 0, "no redraw before the first tick");
		await sleep(300);
		assert.ok(renders >= 2, `ticker drives widget redraws, got ${renders}`);
		w.dispose();
		const after = renders;
		await sleep(300);
		assert.equal(renders, after, "no redraws after dispose");
	});

	it("one row gone does not stop the clock; empty does", async () => {
		let renders = 0;
		let widgetFactory: unknown;
		const ui = {
			setWidget: (_key: unknown, wf: unknown) => {
				widgetFactory = wf;
			},
		} as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		w.add(item("a"));
		(widgetFactory as (tui: unknown, th: unknown) => { render(): string[] })({ requestRender: () => renders++ }, theme);
		w.add(item("b"));
		await sleep(200);
		w.remove("a", "done");
		await sleep(200);
		assert.ok(renders >= 2, "still animating with one row left");
		w.remove("b", "done"); // empty → dispose
		const after = renders;
		await sleep(200);
		assert.equal(renders, after, "clock stops when the widget empties");
	});
});

describe("StatusWidget — width-aware activity clipping (no over-wide regression)", () => {
	// Real themes emit zero-width ANSI — mimic that so width assertions measure
	// actual rendered columns (pi-tui visibleWidth, the same metric pi's own
	// over-wide crash check uses: a row ≤ width here can never trip it).
	const wtheme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	} as never;

	const activityLine = (width: number | undefined, rows: WidgetRow[]): string => {
		const lines = renderWidgetItemLine(
			{ id: "a", title: "ta", startedAt: 0, status: "running", rows },
			wtheme,
			new Spinner(),
			width,
		);
		return lines.find((l) => l.startsWith(EXCERPT_INDENT)) ?? "";
	};

	it("clips long activity to the exact terminal width (tail kept)", () => {
		const activity = activityLine(40, [{ style: "text", content: "x".repeat(500) }]);
		assert.ok(visibleWidth(activity) <= 40, `width ${visibleWidth(activity)} > 40`);
		assert.ok(visibleWidth(activity) > 30, `unnecessarily short: ${visibleWidth(activity)}`);
		assert.ok(activity.includes("\u2026"), "tail ellipsis kept");
		assert.match(activity, /x{10,}$/, "tail (latest content) preserved");
	});

	it("uses more of a wide terminal — no fixed 80 cap", () => {
		const narrow = activityLine(60, [{ style: "text", content: "y".repeat(200) }]);
		const wide = activityLine(200, [{ style: "text", content: "y".repeat(200) }]);
		assert.ok(visibleWidth(wide) > visibleWidth(narrow), "wide terminal shows more of the tail");
		assert.ok(visibleWidth(wide) <= 200);
	});

	it("clips CJK and emoji-ZWJ activity by visible width (grapheme-aware)", () => {
		const cjk = activityLine(50, [{ style: "tool", content: "bash: 调研亮色高亮色处理方案".repeat(30) }]);
		assert.ok(visibleWidth(cjk) <= 50, `CJK width ${visibleWidth(cjk)} > 50`);
		const zwj = activityLine(30, [
			{ style: "text", content: "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67".repeat(200) },
		]);
		assert.ok(visibleWidth(zwj) <= 30, `ZWJ width ${visibleWidth(zwj)} > 30`);
	});

	it("defaults to 80 cols when no width is passed", () => {
		const activity = activityLine(undefined, [{ style: "text", content: "z".repeat(300) }]);
		assert.ok(visibleWidth(activity) <= 80);
	});
});
