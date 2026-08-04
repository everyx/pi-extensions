import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateForContext } from "../index.js";

test("short output passes through untruncated", () => {
	const out = truncateForContext("short result");
	assert.equal(out.text, "short result");
	assert.equal(out.truncation, undefined);
});

test("output over 2000 lines truncates to the tail with truncation info", () => {
	const long = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
	const out = truncateForContext(long);
	assert.ok(out.text.length < long.length, "content truncated");
	assert.ok(out.text.endsWith("line 2099"), "tail preserved");
	assert.ok(out.truncation?.truncated, "truncation flagged");
	assert.equal(out.truncation?.totalLines, 2100);
	assert.equal(out.truncation?.outputLines, 2000);
	assert.equal(out.truncation?.truncatedBy, "lines");
});

test("output over 50KB truncates by bytes", () => {
	const big = "x".repeat(60 * 1024); // single 60KB line
	const out = truncateForContext(big);
	assert.ok(out.truncation?.truncated, "truncation flagged");
	assert.equal(out.truncation?.truncatedBy, "bytes");
	assert.ok(out.text.length <= 50 * 1024, "stays under the byte cap");
});
