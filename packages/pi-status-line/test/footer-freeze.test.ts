import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

/**
 * Wall-clock-free regression test: footer renders (keystrokes, ticks, …)
 * must never recompute TPS. The text freezes when data arrives —
 * message_update freezes the running average, message_end the turn's final
 * (preferring the provider's exact usage.output when present) — and render
 * only displays the cache.
 */

interface FakeTui {
	requestRender(): void;
}
interface FakeTheme {
	fg(color: string, text: string): string;
}
interface FakeFooterData {
	onBranchChange(cb: () => void): () => void;
	getGitBranch(): string | null;
	getAvailableProviderCount(): number;
}
interface FooterInstance {
	render(width: number): string[];
}
type FooterFactory = (tui: FakeTui, theme: FakeTheme, data: FakeFooterData) => FooterInstance;
type Handler = (event?: unknown, ctx?: unknown) => Promise<void> | void;

let fakeNow = 10_000;
const realNow = Date.now;

function setup() {
	const handlers = new Map<string, Handler>();
	let factory: FooterFactory | null = null;
	const pi = {
		on: (event: string, handler: Handler): void => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: {
			getEntries: () => [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 100 } } }],
			getCwd: () => "/tmp",
			getSessionName: () => null,
		},
		ui: {
			setFooter: <F>(f: F): void => {
				factory = f as unknown as FooterFactory;
			},
		},
		getContextUsage: () => ({ percent: 10, contextWindow: 200000 }),
		thinkingLevel: "off",
		model: { id: "m", provider: "p" },
	};
	extension(pi);
	const renderTps = (): string | undefined => {
		assert.ok(factory, "setFooter called on session_start");
		const lines = factory(
			{ requestRender: () => {} },
			{ fg: (_c, s) => s },
			{ onBranchChange: () => () => {}, getGitBranch: () => null, getAvailableProviderCount: () => 1 },
		).render(120);
		return lines[1].match(/\d+(?:\.\d+)?T\/s/)?.[0];
	};
	const fire = async (event: string, payload: unknown = {}): Promise<void> => {
		await handlers.get(event)?.(payload, ctx);
	};
	return { renderTps, fire };
}

const delta = (text: string): unknown => ({ assistantMessageEvent: { type: "x", delta: text } });

describe("footer TPS freeze", () => {
	before(() => {
		Date.now = () => fakeNow;
	});
	after(() => {
		Date.now = realNow;
	});

	it("typing (render without new data) never moves the TPS text", async () => {
		fakeNow = 10_000;
		const { renderTps, fire } = setup();
		await fire("session_start");
		assert.equal(renderTps(), "0.0T/s");

		// A short single-delta turn: debounced at arrival, final on message_end.
		await fire("turn_start");
		await fire("message_update", delta("a".repeat(400))); // 100 tokens, firstToken = t0
		fakeNow = 10_300;
		assert.equal(renderTps(), "0.0T/s", "debounced — no live value yet");
		await fire("message_end", { message: { role: "assistant" } }); // average = 100 tokens / 0.3s
		assert.equal(renderTps(), "333T/s");
		// Typing 10s later: the frozen final must not decay.
		fakeNow = 20_000;
		assert.equal(renderTps(), "333T/s");
		// A new turn keeps the old value until its first token moves it.
		await fire("turn_start");
		assert.equal(renderTps(), "333T/s");
	});

	it("live value updates on data, then freezes", async () => {
		fakeNow = 10_000;
		const { renderTps, fire } = setup();
		await fire("session_start");
		await fire("turn_start");
		await fire("message_update", delta("a".repeat(400)));
		fakeNow = 10_300;
		await fire("message_update", delta("b".repeat(400)));
		// 200 tokens over a 300ms elapsed window.
		assert.equal(renderTps(), "667T/s");
		fakeNow = 20_000;
		assert.equal(renderTps(), "667T/s", "typing must not move it");
	});

	it("message_end prefers the provider's exact output tokens", async () => {
		fakeNow = 10_000;
		const { renderTps, fire } = setup();
		await fire("session_start");
		await fire("turn_start");
		await fire("message_update", delta("a".repeat(400)));
		fakeNow = 10_300;
		await fire("message_end", { message: { role: "assistant", usage: { output: 500 } } });
		// 500 exact tokens / 0.3s — the estimate (100) is replaced, not added to.
		assert.equal(renderTps(), "1667T/s");
		fakeNow = 20_000;
		assert.equal(renderTps(), "1667T/s", "frozen after message_end");
	});
	it("does not count tool execution: a tool result's message_end is not a turn end", async () => {
		fakeNow = 10_000;
		const { renderTps, fire } = setup();
		await fire("session_start");

		await fire("turn_start");
		await fire("message_update", delta("a".repeat(400))); // 100 tokens
		fakeNow = 10_300;
		await fire("message_end", { message: { role: "assistant" } });
		assert.equal(renderTps(), "333T/s");

		// The tool now runs for a minute; pi emits message_start/message_end for
		// the tool *result* too (agent-loop emitToolResultMessage). Taking the
		// clock there divides this turn's tokens by the tool's duration.
		fakeNow = 70_000;
		await fire("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "..." }] } });
		assert.equal(renderTps(), "333T/s", "the tool's duration is not this turn's denominator");
	});

	it("a tool result settles nothing, even while the generation is open", async () => {
		fakeNow = 10_000;
		const { renderTps, fire } = setup();
		await fire("session_start");

		await fire("turn_start");
		await fire("message_update", delta("a".repeat(400))); // 100 tokens, first token at t0

		// pi never produces this ordering — an assistant's message_end always
		// precedes its tool results — so this pins the handler's contract rather
		// than a timeline: a tool result's message_end must not settle the turn.
		fakeNow = 70_000;
		await fire("message_end", { message: { role: "toolResult" } });
		assert.equal(renderTps(), "0.0T/s", "a tool result does not close the generation");

		await fire("message_end", { message: { role: "assistant" } });
		assert.equal(renderTps(), "1.7T/s", "the assistant still settles it: 100 tokens over 60s");
	});
});
