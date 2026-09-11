import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRunCli } from "../run.js";

describe("CLI runner — UTF-8 across chunk boundaries", () => {
	it("multibyte output survives being split between chunks", async () => {
		// The bridge writes `ensure_ascii=False` JSON and pdftotext writes CJK;
		// decoding each chunk on its own turns a split sequence into U+FFFD,
		// which is silent corruption of the recognised text (reproduced with a
		// 40k-character write, which the OS delivers in several chunks).
		const run = createRunCli();
		const res = await run("node", ["-e", "process.stdout.write('\\u6587'.repeat(40000))"]);
		assert.equal(res.code, 0);
		assert.equal(res.stdout.length, 40000, "no characters lost or added");
		assert.ok(!res.stdout.includes("\uFFFD"), "no replacement characters");
	});
});
