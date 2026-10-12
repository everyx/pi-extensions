import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NOTIFICATION_CUSTOM_TYPE } from "../notification.js";
import { PendingReports, pendingLine, reportOf } from "../pending.js";

const abe = { agentId: "abe", label: "counter" };

describe("pendingLine — what a queued report says while it waits", () => {
	it("says the report is queued, then what the agent said", () => {
		assert.equal(
			pendingLine(abe, { status: "completed", output: "bg done" }),
			"Agent @abe — counter (queued): bg done",
		);
	});

	it("carries the outcome for anything but a plain completion", () => {
		assert.equal(
			pendingLine(abe, { status: "failed", output: "boom" }),
			"Agent @abe — counter (failed · queued): boom",
		);
		assert.equal(
			pendingLine(abe, { status: "stopped", output: "partial" }),
			"Agent @abe — counter (stopped · queued): partial",
		);
	});

	it("keeps the first non-empty line only (the card carries the rest)", () => {
		assert.equal(
			pendingLine(abe, { status: "completed", output: "\n\n  1\n2\n3" }),
			"Agent @abe — counter (queued): 1",
		);
	});

	it("leaves no dangling colon for an empty report", () => {
		assert.equal(pendingLine(abe, { status: "completed", output: " \n\t\n" }), "Agent @abe — counter (queued)");
	});

	it("caps the head — flattening a huge output on every frame is not free", () => {
		const line = pendingLine(abe, { status: "completed", output: "x".repeat(5000) });
		assert.ok(line.length < 300, `line stayed short, got ${line.length}`);
		assert.match(line, /\u2026$/);
	});
});

describe("reportOf — which transcript message settles which report", () => {
	it("recognizes our notification card", () => {
		const message = { role: "custom", customType: NOTIFICATION_CUSTOM_TYPE, details: { agent_id: "abe" } };
		assert.equal(reportOf(message), "abe");
	});

	it("ignores everything else (other messages must not drop lines)", () => {
		const others: unknown[] = [
			undefined,
			{ role: "user", content: "hi" },
			// Same shape, different channel: the sub-agent's own chat message.
			{ role: "custom", customType: "subagent-message", details: { agent_id: "abe" } },
			{ role: "custom", customType: NOTIFICATION_CUSTOM_TYPE },
			{ role: "custom", customType: NOTIFICATION_CUSTOM_TYPE, details: { agent_id: 7 } },
		];
		for (const message of others) {
			assert.equal(reportOf(message), undefined);
		}
	});
});

/** Capture the widget through a mock ui.setWidget — the same seam the other
 *  widget tests use. `undefined` content means the widget was unregistered. */
const theme = { fg: (_color: string, text: string) => text } as never;

function capture() {
	let render: ((width: number) => string[]) | undefined;
	const ui = {
		setWidget: (_key: string, content: unknown) => {
			render =
				typeof content === "function"
					? (content as (tui: unknown, th: unknown) => { render(width: number): string[] })(
							{ requestRender: () => {} },
							theme,
						).render
					: undefined;
		},
	} as never;
	return { ui, lines: (width = 200) => render?.(width) ?? [] };
}

const landed = (agentId: string) => ({
	role: "custom",
	customType: NOTIFICATION_CUSTOM_TYPE,
	details: { agent_id: agentId },
});

describe("PendingReports — a line lives exactly as long as its report is queued", () => {
	it("shows one dim line per queued report, and unregisters when the last lands", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, { status: "completed", output: "bg done" });
		assert.deepEqual(lines(), [" Agent @abe — counter (queued): bg done"]);

		pending.settle(landed("abe"));
		assert.deepEqual(lines(), [], "the widget is gone once nothing is queued");
	});

	it("stacks reports in completion order and settles only the matching agent", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, { status: "completed", output: "bg done" });
		pending.add({ agentId: "zoe", label: "index" }, { status: "failed", output: "boom" });
		pending.settle(landed("abe"));
		assert.deepEqual(lines(), [" Agent @zoe — index (failed · queued): boom"]);
	});

	it("settles a resident agent's repeat reports oldest first", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, { status: "completed", output: "first" });
		pending.add(abe, { status: "completed", output: "second" });
		pending.settle(landed("abe"));
		assert.deepEqual(lines(), [" Agent @abe — counter (queued): second"]);
	});

	it("ignores messages that are not our cards (a stray one must not clear a line)", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, { status: "completed", output: "bg done" });
		pending.settle({ role: "user", content: "hi" });
		pending.settle(undefined);
		assert.equal(lines().length, 1);
	});

	it("caps the line to the terminal width", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, { status: "completed", output: "y".repeat(400) });
		for (const line of lines(40)) {
			assert.ok(visibleWidth(line) <= 40, `line fits 40 columns: ${visibleWidth(line)}`);
		}
	});

	it("dispose clears everything (session shutdown)", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, { status: "completed", output: "bg done" });
		pending.dispose();
		assert.deepEqual(lines(), []);
	});
});
