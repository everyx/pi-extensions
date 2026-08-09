import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { dataCard } from "../card.js";
import { createToolView } from "../view.js";

initTheme("light");

const theme = { bg: (_k: string, t: string) => t, fg: (_k: string, t: string) => t, bold: (t: string) => t } as never;

const view = createToolView<{ query: string }, { title: string; lines: string[] }>({
	name: "probe",
	title: (ctx) => ctx.args.query,
	tail: (ctx) => (ctx.status === "processing" ? "running…" : ctx.status === "error" ? "failed" : "done"),
	body: {
		rows: {
			of: (ctx) => ctx.result?.data.lines ?? [],
			rows: [{ style: "text", content: (_ctx, item) => String(item) }],
		},
	},
});

/** Minimal pi ToolRenderContext (structural subset). */
function ctx(over: Partial<Record<string, unknown>> = {}) {
	return {
		args: { query: "q1" },
		state: {},
		toolCallId: "c1",
		invalidate: () => {},
		lastComponent: undefined,
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...over,
	} as never;
}

function lines(c: { render(w: number): string[] }, w = 100): string[] {
	return c.render(w);
}

describe("createToolView — header ownership while running", () => {
	it("renderCall renders the header line while processing", () => {
		const out = lines(view.renderCall({ query: "q1" }, theme, ctx({ isPartial: true })));
		assert.ok(out.length >= 1, "call renders a header line");
		assert.match(out[0] ?? "", /probe/);
		assert.match(out[0] ?? "", /q1/);
		assert.match(out[0] ?? "", /running/);
	});

	it("renderResult renders a bare body (no header) while processing — call owns the header", () => {
		const out = lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: ["one", "two"] } } },
				{ expanded: false, isPartial: true },
				theme,
				ctx({ isPartial: true }),
			),
		);
		// Body rows present…
		assert.ok(
			out.some((l) => l.includes("one")),
			"body row rendered",
		);
		assert.ok(
			out.some((l) => l.includes("two")),
			"body row rendered",
		);
		// …but the header (name / title / tail) must not repeat.
		assert.ok(!out.some((l) => l.includes("probe")), "no repeated name in streaming result");
		assert.ok(!out.some((l) => l.includes("running")), "no repeated tail in streaming result");
	});

	it("renderResult renders the full card (header + body) once complete", () => {
		const out = lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: ["one"] } } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ isPartial: false }),
			),
		);
		assert.ok(
			out.some((l) => l.includes("probe")),
			"name in final header",
		);
		assert.ok(
			out.some((l) => l.includes("done")),
			"tail in final header",
		);
		assert.ok(
			out.some((l) => l.includes("one")),
			"body row in final card",
		);
	});

	it("dataCard expanded renders every row (fold lifted)", () => {
		const body = Array.from({ length: 16 }, (_, i) => ({ style: "text" as const, content: `line ${i + 1}` }));
		const collapsed = lines(dataCard({ status: "success", name: "probe", body, expanded: false }, theme));
		const expanded = lines(dataCard({ status: "success", name: "probe", body, expanded: true }, theme));
		assert.ok(
			collapsed.some((l) => l.includes("earlier lines")),
			"collapsed shows the fold hint",
		);
		assert.ok(!expanded.some((l) => l.includes("earlier lines")), "expanded drops the fold hint");
		assert.ok(
			expanded.some((l) => l.includes("line 1")),
			"expanded shows the first row",
		);
		assert.ok(
			expanded.some((l) => l.includes("line 16")),
			"expanded shows the last row",
		);
	});
});
