import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateTokens, formatTps, formatTtft, SlidingWindow, TtftAvg, TurnMetrics } from "../tps.js";

describe("estimateTokens", () => {
	it("empty → 0", () => assert.equal(estimateTokens(""), 0));
	it("chars/4 ceiling", () => {
		assert.equal(estimateTokens("abcd"), 1);
		assert.equal(estimateTokens("abcde"), 2);
	});
});

describe("formatTps", () => {
	it("formats with unit — compact atomic like R (T/s)", () => {
		assert.equal(formatTps(42.123), "42.1T/s");
		assert.equal(formatTps(123.4), "123T/s");
	});
});

describe("formatTtft", () => {
	it("ms vs s — compact like R, no space (T prefix)", () => {
		assert.equal(formatTtft(800), "T800ms");
		assert.equal(formatTtft(1200), "T1.2s");
	});
});

describe("SlidingWindow", () => {
	it("prunes outside window", () => {
		const w = new SlidingWindow(1000);
		w.push(0, 10);
		w.push(500, 10);
		w.push(1500, 10);
		assert.equal(w.tokens, 20);
	});
});

describe("TurnMetrics", () => {
	it("TTFT = firstToken - turnStart", () => {
		const m = new TurnMetrics();
		m.startTurn(1000);
		m.addDelta("hello", 1500);
		assert.equal(m.ttftMs, 500);
	});

	it("liveTps debounced <250ms", () => {
		const m = new TurnMetrics();
		const t0 = 1000;
		m.startTurn(t0);
		m.addDelta("hello world ", t0 + 10);
		assert.equal(m.liveTps(t0 + 100), null);
	});

	it("liveTps after debounce", () => {
		const m = new TurnMetrics();
		const t0 = 1000;
		m.startTurn(t0);
		m.addDelta("a".repeat(400), t0 + 300);
		m.addDelta("b".repeat(400), t0 + 800);
		assert.ok((m.liveTps(t0 + 1300) ?? 0) > 0);
	});

	it("averageTps after debounce", () => {
		const m = new TurnMetrics();
		const t0 = 1000;
		m.startTurn(t0);
		m.addDelta("a".repeat(400), t0 + 100);
		assert.equal(m.averageTps(t0 + 200), null, "debounced");
		assert.ok((m.averageTps(t0 + 1500) ?? 0) > 0);
	});

	it("clear resets", () => {
		const m = new TurnMetrics();
		m.startTurn(1000);
		m.addDelta("hi", 1200);
		m.clear();
		assert.equal(m.ttftMs, null);
		assert.equal(m.liveTps(2000), null);
	});
});

describe("TtftAvg", () => {
	it("averages across turns", () => {
		const a = new TtftAvg();
		a.push(1000);
		a.push(2000);
		assert.equal(a.avgMs, 1500);
	});
	it("null when empty", () => {
		assert.equal(new TtftAvg().avgMs, null);
	});
});
