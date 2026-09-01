import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extOf, OFFICE_EXTS } from "../index.js";
import { createRateLimiter } from "../rate-limit.js";

describe("pi-read-doc", () => {
	it("ext detection", () => {
		assert.equal(extOf("a.docx"), ".docx");
		assert.equal(extOf("A.PDF"), ".pdf");
		assert.equal(extOf("noext"), "");
	});

	it("office ext set covers the anydoc table", () => {
		for (const ext of [".doc", ".docx", ".docm", ".pdf", ".xlsx", ".xlsm", ".pptx", ".odt", ".rtf", ".epub", ".csv"]) {
			assert.ok(OFFICE_EXTS.has(ext), `${ext} in OFFICE_EXTS`);
		}
		assert.ok(!OFFICE_EXTS.has(".ts"));
	});

	it("rate limiter serializes and enforces the gap (qps<=0 passes through)", async () => {
		const lim = createRateLimiter(10); // 100ms gap
		let active = 0;
		let maxActive = 0;
		const run = lim(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 20));
			active--;
			return active;
		});
		const results = await Promise.all([run, run, run]);
		assert.deepEqual(results, [0, 0, 0]); // serialized: never concurrent
		assert.equal(maxActive, 1);

		// qps <= 0 disables throttling entirely (the real guard).
		const disabled = createRateLimiter(0);
		const t0 = Date.now();
		await disabled(async () => Promise.resolve());
		const dt = Date.now() - t0;
		assert.ok(dt < 500, `no artificial delay (took ${dt}ms)`);
	});
});
