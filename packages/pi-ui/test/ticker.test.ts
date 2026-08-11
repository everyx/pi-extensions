/**
 * Tests for the unified animation ticker (pi-ui).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ticker } from "../ticker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ticker — unified animation cadence", () => {
	it("calls a subscriber on its interval", async () => {
		let n = 0;
		const h = ticker.subscribe(() => n++, 20);
		await sleep(75);
		assert.ok(n >= 2, `expected ≥2 ticks in 75ms, got ${n}`);
		h.unsubscribe();
	});

	it("runs at the smallest registered interval (min aggregation)", async () => {
		let slow = 0;
		let fast = 0;
		const hs = ticker.subscribe(() => slow++, 60);
		const hf = ticker.subscribe(() => fast++, 20);
		await sleep(75);
		assert.ok(fast >= 2, `fast expected ≥2 ticks, got ${fast}`);
		// The slow subscriber is driven by the fast cadence too — the outer
		// redraw rate matches the fastest internal animation need.
		assert.ok(slow >= 2, `min-cadence should drive slow too, got ${slow}`);
		hs.unsubscribe();
		hf.unsubscribe();
	});

	it("stops calling after unsubscribe", async () => {
		let n = 0;
		const h = ticker.subscribe(() => n++, 20);
		await sleep(45);
		h.unsubscribe();
		const snapshot = n;
		await sleep(45);
		assert.equal(n, snapshot);
	});

	it("a throwing callback does not break the others", async () => {
		let n = 0;
		const bad = ticker.subscribe(() => {
			throw new Error("boom");
		}, 20);
		const good = ticker.subscribe(() => n++, 20);
		await sleep(45);
		assert.ok(n >= 1, "good subscriber keeps ticking past the bad one");
		bad.unsubscribe();
		good.unsubscribe();
	});

	it("subscriber count tracks live subscriptions", () => {
		const h = ticker.subscribe(() => {}, 20);
		assert.equal(ticker.subscriberCount, 1);
		h.unsubscribe();
		assert.equal(ticker.subscriberCount, 0);
	});
});
