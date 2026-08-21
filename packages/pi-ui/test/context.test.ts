import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stashOverflow, truncationMarker } from "../context.js";

describe("stashOverflow", () => {
	it("keeps the head by default and stashes the full text", () => {
		const text = `# Doc\n\n${"x".repeat(100_000)}`;
		const r = stashOverflow(text, "agent-1");
		assert.ok(r.text.startsWith("# Doc"));
		const stash = r.stashPath ?? "";
		assert.ok(stash.startsWith("/tmp/pi-stash-"));
		assert.ok(existsSync(stash));
		assert.equal(readFileSync(stash, "utf8"), text, "stash holds the FULL text");
	});

	it("keep tail keeps the latest (pi-bash style)", () => {
		const text = `${"x".repeat(100_000)}\n\nTHE END`;
		const r = stashOverflow(text, "agent-2", { keep: "tail" });
		assert.ok(r.text.endsWith("THE END"), `tail must be kept, got: …${r.text.slice(-40)}`);
		assert.ok(r.stashPath);
	});

	it("same key → same filename (idempotent overwrite)", () => {
		const a = stashOverflow(`x`.repeat(100_000), "same-key");
		const b = stashOverflow(`y`.repeat(100_000), "same-key");
		assert.equal(a.stashPath, b.stashPath);
	});

	it("short text passes through with no stash", () => {
		const r = stashOverflow("short", "k");
		assert.equal(r.text, "short");
		assert.equal(r.stashPath, undefined);
	});
});

describe("truncationMarker", () => {
	it("embeds the path in the standard inline form", () => {
		assert.equal(
			truncationMarker("/tmp/pi-stash-abc.txt"),
			"\n\n(output truncated — full output: /tmp/pi-stash-abc.txt)",
		);
	});
});
