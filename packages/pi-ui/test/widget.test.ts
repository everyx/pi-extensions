/**
 * Tests for StatusWidget lifetime progress meta (`1/3`, `(1+2)/3`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { StatusWidget, type WidgetItem } from "../widget.js";

/** Captures the widget's render function through a mock ui.setWidget. */
function capture(ui: { setWidget: ExtensionUIContext["setWidget"] }) {
	let render: (() => string[]) | undefined;
	ui.setWidget = (_key, widget) => {
		render =
			typeof widget === "function"
				? (widget as unknown as (tui: unknown, th: unknown) => { render(): string[] })(
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
	it("renders done/total while items run (0/2)", () => {
		const ui = { setWidget: () => {} } as never;
		const w = new StatusWidget(ui as ExtensionUIContext, "Agents");
		const lines = capture(ui);
		w.add(item("a"));
		w.add(item("b"));
		const title = lines().find((l) => l.includes("Agents"));
		assert.ok(title);
		assert.match(title, /muted:0\/2/);
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
		assert.match(title, /muted:1\/2/);
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
		assert.match(title, /muted:\(1\+error:1\)\/3/);
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
		assert.match(title, /muted:\(0\+error:2\)\/3/);
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
		assert.match(title, /muted:0\/2/);
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
		assert.match(title, /muted:0\/1/);
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
