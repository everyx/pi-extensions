import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentCompletion } from "../agent-process.js";
import { NOTIFICATION_CUSTOM_TYPE, notifyCompletion } from "../notification.js";
import type { RegisteredAgent } from "../registry.js";

type SendCall = Parameters<ExtensionAPI["sendMessage"]>;

/** Capture what the notification hands the host, without a host. */
function capture(): { pi: ExtensionAPI; calls: SendCall[] } {
	const calls: SendCall[] = [];
	const pi = {
		sendMessage: (...args: SendCall) => {
			calls.push(args);
		},
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

const abe: RegisteredAgent = {
	agentId: "abe",
	label: "counter",
	stoppedByControl: false,
	stop: async () => {},
};

const done: AgentCompletion = {
	status: "completed",
	output: "bg done",
	stats: { tokens: 0, toolUses: 0, durationMs: 0 },
};

describe("notifyCompletion — how a report reaches the parent", () => {
	// The regression this pins: a followUp is drained only when the model stops
	// calling tools (agent-loop.js:192), and a model waiting on this agent never
	// does — it polls. Steering drains at every tool boundary instead, so no
	// waiting style can deadlock the report.
	it("steers, so a waiting model still receives it", () => {
		const { pi, calls } = capture();
		notifyCompletion(pi, abe, done);

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.[1]?.deliverAs, "steer");
		assert.equal(calls[0]?.[1]?.triggerTurn, true);
	});

	it("wears the type the renderer and the pending line both read", () => {
		const { pi, calls } = capture();
		notifyCompletion(pi, abe, done);

		assert.equal(calls[0]?.[0].customType, NOTIFICATION_CUSTOM_TYPE);
	});
});
