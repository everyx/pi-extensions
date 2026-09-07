import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateTokens, formatTps, formatTtft, TtftAvg, TurnMetrics } from "../tps.js";

describe("estimateTokens", () => {
	it("empty → 0", () => assert.equal(estimateTokens(""), 0));
	it("chars/4 ceiling (ASCII)", () => {
		assert.equal(estimateTokens("abcd"), 1);
		assert.equal(estimateTokens("abcde"), 2);
	});
	it("CJK chars count ~1 token each", () => {
		assert.equal(estimateTokens("你好"), 2);
		assert.equal(estimateTokens("你好世界"), 4);
	});
	it("mixed CJK + ASCII — ceil once on the weighted total", () => {
		assert.equal(estimateTokens("ab你好"), 3); // ceil(2 + 2/4)
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

	it("liveTps after debounce = running average (elapsed denominator)", () => {
		const m = new TurnMetrics();
		const t0 = 1000;
		m.startTurn(t0);
		m.addDelta("a".repeat(400), t0 + 300);
		m.addDelta("b".repeat(400), t0 + 800);
		// 800 chars → ceil(800/4) = 200 tokens over 1000ms elapsed
		assert.equal(m.liveTps(t0 + 1300), 200);
	});

	it("gaps during generation count in the denominator", () => {
		const m = new TurnMetrics();
		const t0 = 1000;
		m.startTurn(t0);
		m.addDelta("a".repeat(400), t0 + 300);
		m.addDelta("b".repeat(400), t0 + 800);
		// Same 200 tokens, but 3s elapsed — the 2.2s silent gap dilutes the rate.
		assert.equal(m.liveTps(t0 + 3300), 200 / 3);
	});

	it("tokens estimated once on cumulative chars, never per delta (ceil inflation guard)", () => {
		const m = new TurnMetrics();
		m.startTurn(1000);
		for (const ch of ["a", "b", "c", "d"]) m.addDelta(ch, 1000);
		// Per-delta ceil would give 4; once on the total it is 1.
		assert.equal(m.estimatedTokens, 1);
	});

	it("averageTps prefers the provider's exact token count", () => {
		const m = new TurnMetrics();
		m.startTurn(1000);
		m.addDelta("a".repeat(400), 1300);
		assert.equal(m.averageTps(1800, 500), 1000); // 500 exact tokens / 0.5s
	});

	it("averageTps falls back to the estimate when exact is absent or zero", () => {
		const m = new TurnMetrics();
		m.startTurn(1000);
		m.addDelta("a".repeat(400), 1300);
		assert.equal(m.averageTps(1800), 200); // estimate ceil(400/4)=100 / 0.5s
		assert.equal(m.averageTps(1800, 0), 200); // exact 0 is treated as absent
	});

	it("averageTps debounced like live", () => {
		const m = new TurnMetrics();
		m.startTurn(1000);
		m.addDelta("a".repeat(400), 1000);
		assert.equal(m.averageTps(1100), null);
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
