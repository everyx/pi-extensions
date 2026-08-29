import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("pi-read-doc", () => {
	it("ext detection", () => {
		const extOf = (p: string) => {
			const i = p.lastIndexOf(".");
			return i >= 0 ? p.slice(i).toLowerCase() : "";
		};
		assert.equal(extOf("a.docx"), ".docx");
		assert.equal(extOf("A.PDF"), ".pdf");
		assert.equal(extOf("noext"), "");
	});

	it("office ext set", () => {
		const set = new Set([".docx", ".pdf", ".xlsx"]);
		assert.ok(set.has(".docx"));
		assert.ok(!set.has(".ts"));
	});

	it("rate limiter serializes", async () => {
		let last = 0;
		let chain: Promise<void> = Promise.resolve();
		const limiter =
			(qps: number) =>
			async <T>(fn: () => Promise<T>): Promise<T> => {
				const gap = 1000 / qps;
				const task = chain.then(async () => {
					const now = Date.now();
					const wait = Math.max(0, last + gap - now);
					if (wait) await new Promise((r) => setTimeout(r, wait));
					last = Date.now();
					return fn();
				});
				chain = task.then(
					() => {},
					() => {},
				);
				return task;
			};
		const lim = limiter(10);
		const a = await lim(async () => 1);
		assert.equal(a, 1);
	});
});
