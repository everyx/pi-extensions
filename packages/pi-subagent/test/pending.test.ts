import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentCompletion } from "../agent-process.js";
import { NOTIFICATION_CUSTOM_TYPE } from "../notification.js";
import { PendingReports, pendingLine, reportOf } from "../pending.js";

const abe = { agentId: "abe", label: "counter" };

/** `add` keeps the whole report so it can be handed to pi again — the line
 *  itself only reads the status and the text. */
const rep = (status: AgentCompletion["status"], output: string): AgentCompletion => ({
	status,
	output,
	stats: { tokens: 0, toolUses: 0, durationMs: 0 },
});

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

		pending.add(abe, rep("completed", "bg done"));
		assert.deepEqual(lines(), [" Agent @abe — counter (queued): bg done"]);

		pending.settle(landed("abe"));
		assert.deepEqual(lines(), [], "the widget is gone once nothing is queued");
	});

	it("stacks reports in completion order and settles only the matching agent", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, rep("completed", "bg done"));
		pending.add({ agentId: "zoe", label: "index" }, rep("failed", "boom"));
		pending.settle(landed("abe"));
		assert.deepEqual(lines(), [" Agent @zoe — index (failed · queued): boom"]);
	});

	it("settles a resident agent's repeat reports oldest first", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, rep("completed", "first"));
		pending.add(abe, rep("completed", "second"));
		pending.settle(landed("abe"));
		assert.deepEqual(lines(), [" Agent @abe — counter (queued): second"]);
	});

	it("ignores messages that are not our cards (a stray one must not clear a line)", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, rep("completed", "bg done"));
		pending.settle({ role: "user", content: "hi" });
		pending.settle(undefined);
		assert.equal(lines().length, 1);
	});

	it("caps the line to the terminal width", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, rep("completed", "y".repeat(400)));
		for (const line of lines(40)) {
			assert.ok(visibleWidth(line) <= 40, `line fits 40 columns: ${visibleWidth(line)}`);
		}
	});

	it("dispose clears everything (session shutdown)", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);

		pending.add(abe, rep("completed", "bg done"));
		pending.dispose();
		assert.deepEqual(lines(), []);
	});
});

describe("PendingReports — undelivered reports get a second chance", () => {
	it("hands every waiting report back, with the payload to send again", () => {
		const { ui } = capture();
		const pending = new PendingReports(ui);
		pending.add(abe, rep("completed", "bg done"));
		pending.add({ agentId: "zoe", label: "index" }, rep("stopped", "half"));

		const retried: string[] = [];
		const n = pending.undelivered(Date.now(), (report) =>
			retried.push(`${report.agent.agentId}:${report.completion.status}`),
		);

		assert.equal(n, 2, "both are still waiting");
		assert.deepEqual(retried, ["abe:completed", "zoe:stopped"], "in the order they were queued");
	});

	it("has nothing to hand back once the cards landed", () => {
		const { ui } = capture();
		const pending = new PendingReports(ui);
		pending.add(abe, rep("completed", "bg done"));
		pending.settle({ role: "custom", customType: NOTIFICATION_CUSTOM_TYPE, details: { agent_id: "abe" } });

		let calls = 0;
		assert.equal(
			pending.undelivered(Date.now(), () => calls++),
			0,
		);
		assert.equal(calls, 0, "a delivered report is not sent twice");
	});

	it("keeps the line while it retries — a second send is not a delivery", () => {
		const { ui, lines } = capture();
		const pending = new PendingReports(ui);
		pending.add(abe, rep("completed", "bg done"));

		pending.undelivered(Date.now(), () => {});
		assert.equal(lines().length, 1, "still waiting: no card has landed");
	});

	it("does not send the same report twice when settles arrive in a burst", () => {
		const { ui } = capture();
		const pending = new PendingReports(ui);
		pending.add(abe, rep("completed", "bg done"));

		let calls = 0;
		const deliver = () => calls++;
		pending.undelivered(Date.now(), deliver);
		// A second settle 300 ms later, its timer firing before the first retry
		// could have landed the card.
		assert.equal(pending.undelivered(Date.now(), deliver), 0);
		assert.equal(calls, 1, "one retry in flight per report");
	});

	it("tries again once the previous retry has had time to land", async () => {
		const { ui } = capture();
		const pending = new PendingReports(ui, { retryCooldownMs: 10 });
		pending.add(abe, rep("completed", "bg done"));

		let calls = 0;
		pending.undelivered(Date.now(), () => calls++);
		await new Promise((r) => setTimeout(r, 20));
		pending.undelivered(Date.now(), () => calls++);
		assert.equal(calls, 2, "still pending, so the second settle tries again");
	});

	it("leaves alone a report queued after the settle (its delivery is in flight)", () => {
		const { ui } = capture();
		const pending = new PendingReports(ui);
		pending.add(abe, rep("completed", "bg done"));

		let calls = 0;
		const settledAt = Date.now() - 1;
		assert.equal(
			pending.undelivered(settledAt, () => calls++),
			0,
		);
		assert.equal(calls, 0);
	});
});
