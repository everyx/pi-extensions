/**
 * Tests for date helpers (date.ts) — ISO → relative age via fromnow.
 *
 * fromnow computes against the real current time (no injected clock), so
 * assertions match the shape ("N years and M months ago") rather than exact
 * values.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isoToRelativeAge } from "../date.js";

describe("isoToRelativeAge", () => {
	it("compound years+months for old dates", () => {
		assert.match(isoToRelativeAge("2020-01-15T00:00:00Z"), /^\d+ years? and \d+ months? ago$/);
	});
	it("days for recent dates", () => {
		assert.match(isoToRelativeAge(new Date(Date.now() - 3 * 86_400_000).toISOString()), /^\d+ days? ago$|^1 day and /);
	});
	it("just now for the current instant", () => {
		assert.equal(isoToRelativeAge(new Date().toISOString()), "just now");
	});
	it("unparseable stays as-is", () => {
		assert.equal(isoToRelativeAge("N/A"), "N/A");
		assert.equal(isoToRelativeAge(""), "");
	});
	it("future dates use from-now phrasing", () => {
		assert.match(isoToRelativeAge(new Date(Date.now() + 30 * 86_400_000).toISOString()), /from now$/);
	});
});
