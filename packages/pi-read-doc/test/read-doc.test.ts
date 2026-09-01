import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extOf, OFFICE_EXTS, truncateForLlm } from "../index.js";
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

describe("LLM budget truncation (root SPEC: LLM context 截断保护)", () => {
	it("passes short text through unchanged", () => {
		const r = truncateForLlm("hello\nworld");
		assert.equal(r.text, "hello\nworld");
		assert.equal(r.truncated, false);
	});

	it("head-truncates at the line budget, with a marker", () => {
		const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
		const r = truncateForLlm(text);
		assert.equal(r.truncated, true);
		assert.ok(r.text.startsWith("line 0"));
		assert.ok(r.text.includes("line 1999"));
		assert.ok(!r.text.includes("line 2000"));
		assert.match(r.text, /truncated: first 2000 lines/);
	});

	it("head-truncates at the byte budget (whole lines kept)", () => {
		const text = Array.from({ length: 600 }, () => "x".repeat(100)).join("\n"); // 60,599 bytes
		const r = truncateForLlm(text);
		assert.equal(r.truncated, true);
		assert.ok(r.text.startsWith("x"));
		const body = r.text.split("\n(truncated:")[0];
		assert.ok(Buffer.byteLength(body, "utf-8") <= 50 * 1024, "body within the byte budget");
		assert.match(r.text, /truncated: first \d+ lines \/ \d+ bytes; total \d+ lines \/ \d+ bytes/);
	});

	it("counts UTF-8 bytes, not chars (CJK regression)", () => {
		// 500 lines × 50 CJK chars: 25,000 "chars" (fits a char proxy) but
		// 75,500 UTF-8 bytes (over budget) — must truncate.
		const text = Array.from({ length: 500 }, () => "文".repeat(50)).join("\n");
		const r = truncateForLlm(text);
		assert.equal(r.truncated, true);
		const body = r.text.split("\n(truncated:")[0];
		assert.ok(Buffer.byteLength(body, "utf-8") <= 50 * 1024);
		assert.ok(Buffer.byteLength(body, "utf-8") > 40 * 1024, "kept most of the budget");
	});
});
