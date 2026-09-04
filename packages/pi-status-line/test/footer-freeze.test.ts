import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

/**
 * Wall-clock-free regression test: footer renders (keystrokes, ticks, …)
 * must never recompute TPS. The text freezes when data arrives —
 * message_update freezes the live value, message_end the turn average —
 * and render only displays the cache.
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
		await fire("message_end"); // average = 100 tokens / 0.3s
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
		// 200 tokens over a 300ms window span.
		assert.equal(renderTps(), "667T/s");
		fakeNow = 20_000;
		assert.equal(renderTps(), "667T/s", "typing must not move it");
	});
});
