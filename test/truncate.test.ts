import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateForContext } from "../index.js";

test("short output passes through untruncated", () => {
	assert.equal(truncateForContext("short result"), "short result");
});

test("output over 2000 lines truncates to the tail", () => {
	const long = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
	const out = truncateForContext(long);
	assert.ok(out.length < long.length, "content truncated");
	assert.ok(out.endsWith("line 2099"), "tail preserved");
});

test("output over 50KB truncates by bytes", () => {
	const big = "x".repeat(60 * 1024); // single 60KB line
	const out = truncateForContext(big);
	assert.ok(out.length <= 50 * 1024, "stays under the byte cap");
});
