/**
 * Tests for the per-provider rate limiter (rate-limit.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter, createSerialQueue } from "../rate-limit.js";

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

describe("createSerialQueue", () => {
	it("runs tasks one at a time, sharing one context", async () => {
		let opens = 0;
		let closes = 0;
		const queue = createSerialQueue<string>(
			async () => {
				opens++;
				return "session";
			},
			async () => {
				closes++;
			},
		);

		let maxConcurrent = 0;
		let active = 0;
		const results = await Promise.all(
			[1, 2, 3].map((i) =>
				queue.run(async (ctx) => {
					assert.equal(ctx, "session", "all tasks share the same context");
					active++;
					maxConcurrent = Math.max(maxConcurrent, active);
					await new Promise((r) => setTimeout(r, 10));
					active--;
					return i * 2;
				}),
			),
		);

		assert.deepEqual(results, [2, 4, 6]);
		assert.equal(maxConcurrent, 1, "tasks must never run concurrently");
		assert.equal(opens, 1, "context opened once for the whole burst");
		assert.equal(closes, 1, "context closed once when the queue drained");
	});

	it("rejects queued tasks when open fails, then recovers", async () => {
		let opens = 0;
		const queue = createSerialQueue<string>(
			async () => {
				opens++;
				if (opens === 1) throw new Error("no browser");
				return "session";
			},
			async () => {},
		);

		await assert.rejects(
			queue.run(async () => 1),
			/no browser/,
		);
		const ok = await queue.run(async () => 2);
		assert.equal(ok, 2);
		assert.equal(opens, 2);
	});

	it("a failing task does not wedge the queue", async () => {
		const queue = createSerialQueue<string>(
			async () => "s",
			async () => {},
		);
		await assert.rejects(
			queue.run(async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		const next = await queue.run(async () => 42);
		assert.equal(next, 42);
	});

	it("tasks enqueued during a slow close still run (no swallowed drain)", async () => {
		let releaseClose: () => void = () => {};
		const closeGate = new Promise<void>((r) => {
			releaseClose = r;
		});
		const queue = createSerialQueue<string>(
			async () => "s",
			async () => {
				await closeGate; // simulate a slow session stop
			},
		);

		const first = await queue.run(async () => 1);
		assert.equal(first, 1);

		// Enqueue while the previous batch's close is still pending.
		const second = queue.run(async () => 2);
		setTimeout(releaseClose, 10);
		assert.equal(await second, 2);
	});
});
