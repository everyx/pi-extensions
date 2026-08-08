/**
 * Tests for the per-provider rate limiter (rate-limit.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMutex, createRateLimiter } from "../rate-limit.js";

describe("createRateLimiter", () => {
	it("no qps = unlimited pass-through (no serialization)", async () => {
		const limiter = createRateLimiter();
		let calls = 0;
		const results = await Promise.all([1, 2, 3].map(() => limiter.run(async () => ++calls)));
		assert.deepEqual(results, [1, 2, 3]);
	});

	it("serializes concurrent calls with a minimum interval of 1000/qps", async () => {
		const limiter = createRateLimiter(2); // 500ms interval
		const timestamps: number[] = [];
		await Promise.all([1, 2, 3].map(() => limiter.run(async () => timestamps.push(Date.now()))));
		assert.equal(timestamps.length, 3);
		// The first two pushes happen immediately (chain starts resolved), the
		// third waits ≥500ms after the second.
		const gaps = [(timestamps[1] ?? 0) - (timestamps[0] ?? 0), (timestamps[2] ?? 0) - (timestamps[1] ?? 0)];
		assert.ok((gaps[1] ?? 0) >= 450, `expected ≥450ms gap between serialized calls, got ${gaps[1]}`);
	});

	it("a failing call does not wedge the chain", async () => {
		const limiter = createRateLimiter(2);
		let calls = 0;
		const first = limiter.run(async () => {
			throw new Error("boom");
		});
		await assert.rejects(first, /boom/);
		const second = await limiter.run(async () => ++calls);
		assert.equal(second, 1);
	});

	it("qps <= 0 treated as unlimited", async () => {
		const limiter = createRateLimiter(0);
		const results = await Promise.all([1, 2].map(() => limiter.run(async () => 1)));
		assert.deepEqual(results, [1, 1]);
	});

	it("qps maps to a 1000/qps minimum interval", () => {
		// Research-backed provider limits: exa mcp 3, tavily 1, parallel 10.
		assert.equal(1000 / 3, 333.3333333333333);
		assert.equal(1000 / 1, 1000);
		assert.equal(1000 / 10, 100);
	});
});

describe("createMutex", () => {
	it("runs one call at a time, no extra interval between calls", async () => {
		const mutex = createMutex();
		const active: number[] = [];
		let maxConcurrent = 0;
		const timestamps: number[] = [];

		await Promise.all(
			[1, 2, 3].map(() =>
				mutex.run(async () => {
					active.push(1);
					maxConcurrent = Math.max(maxConcurrent, active.length);
					timestamps.push(Date.now());
					await new Promise((r) => setTimeout(r, 20));
					active.pop();
				}),
			),
		);

		assert.equal(maxConcurrent, 1, "mutex must never run calls concurrently");
		assert.equal(timestamps.length, 3);
	});

	it("a failing call does not wedge the queue", async () => {
		const mutex = createMutex();
		let calls = 0;
		await assert.rejects(
			mutex.run(async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		const next = await mutex.run(async () => ++calls);
		assert.equal(next, 1);
	});
});
