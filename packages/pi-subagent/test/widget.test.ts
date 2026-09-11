import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentWidget, activityToRows } from "../widget.js";

describe("activityToRows — pure data (width clipping lives in the widget render layer)", () => {
	it("maps short tool args to one tool row", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "ls -la" });
		assert.deepEqual(rows, [{ style: "tool", content: "bash: ls -la" }]);
	});

	it("does not truncate long args (render layer clips to terminal width)", () => {
		const rows = activityToRows({ kind: "tool", name: "write", args: "x".repeat(5000) });
		const content = rows[0]?.content ?? "";
		assert.equal(content, `write: ${"x".repeat(5000)}`);
	});

	it("flattens multi-line tool args (heredoc payloads) to a single line", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "cat > /tmp/x.py << 'EOF'\nimport colorsys\nEOF" });
		const content = rows[0]?.content ?? "";
		assert.ok(!content.includes("\n"), "newlines must be flattened");
		assert.match(content, /import colorsys/);
	});

	it("keeps streamed text as-is (no clipping at the data layer)", () => {
		const rows = activityToRows({ kind: "text", text: "y".repeat(1000) });
		assert.equal(rows[0]?.content, "y".repeat(1000));
	});
});

// ── Removal cascade ──────────────────────────────────────
//
// A sub-agent's descendants are displayed on the root widget as nested rows
// reported by the sub-agent itself. When that sub-agent is stopped, nothing
// will ever report their removal (the reporter is the process that died), so
// the surface that owns the rows must take the whole subtree down with it.

/** Capture the widget's render function through a mock ui.setWidget — the
 *  same seam pi-ui's own widget tests use. */
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s } as never;

function capture() {
	let render: ((width?: number) => string[]) | undefined;
	const ui = {
		setWidget: (_key: string, widget: unknown) => {
			render =
				typeof widget === "function"
					? (widget as (tui: unknown, th: unknown) => { render(width?: number): string[] })(
							{ requestRender: () => {} },
							theme,
						).render
					: undefined;
		},
	} as never;
	return { ui, lines: () => (render?.() ?? []).join("\n") };
}

const agentRow = (id: string, label: string) =>
	({ agentId: id, label, startedAt: 0, getLatestActivity: () => undefined }) as never;

describe("AgentWidget — a removed row takes its subtree with it", () => {
	it("removing a parent drops its nested descendants (no orphan spinner)", () => {
		const { ui, lines } = capture();
		const w = new AgentWidget(ui);
		w.add(agentRow("a", "Alpha"));
		w.addNested({ agentId: "b", label: "Bravo", startedAt: 0, indent: 1, status: "running", parentId: "a" });
		w.addNested({ agentId: "c", label: "Charlie", startedAt: 0, indent: 2, status: "running", parentId: "b" });
		w.add(agentRow("z", "Zulu")); // unrelated row keeps the widget alive
		assert.match(lines(), /Bravo[\s\S]*Charlie/);

		w.remove("a", "stopped");

		const after = lines();
		assert.doesNotMatch(after, /Bravo|Charlie/, "the subtree must not outlive its parent's row");
		assert.match(after, /Zulu/, "unrelated rows stay");
		w.dispose();
	});

	it("removing a nested row drops only its own subtree", () => {
		const { ui, lines } = capture();
		const w = new AgentWidget(ui);
		w.add(agentRow("a", "Alpha"));
		w.addNested({ agentId: "b", label: "Bravo", startedAt: 0, indent: 1, status: "running", parentId: "a" });
		w.addNested({ agentId: "c", label: "Charlie", startedAt: 0, indent: 2, status: "running", parentId: "b" });

		w.remove("b", "done");

		const after = lines();
		assert.doesNotMatch(after, /Bravo|Charlie/);
		assert.match(after, /Alpha/, "the parent survives its child's removal");
		w.dispose();
	});
});
