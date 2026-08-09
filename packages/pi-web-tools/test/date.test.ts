/**
 * Tests for date helpers (date.ts) — ISO → relative age.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isoToRelativeAge, msToRelativeAge } from "../date.js";

describe("isoToRelativeAge", () => {
	const now = new Date("2026-08-08T12:00:00Z");

	it("minutes", () => {
		assert.equal(isoToRelativeAge("2026-08-08T11:55:00Z", now), "about 5 minutes ago");
	});
	it("hours", () => {
		assert.equal(isoToRelativeAge("2026-08-08T09:00:00Z", now), "about 3 hours ago");
	});
	it("days", () => {
		assert.equal(isoToRelativeAge("2026-08-05T12:00:00Z", now), "about 3 days ago");
	});
	it("weeks", () => {
		assert.equal(isoToRelativeAge("2026-07-20T12:00:00Z", now), "about 2 weeks ago");
	});
	it("months", () => {
		assert.equal(isoToRelativeAge("2026-03-08T12:00:00Z", now), "about 5 months ago");
	});
	it("years", () => {
		assert.equal(isoToRelativeAge("2024-05-22T00:00:00Z", now), "about 2 years ago");
	});
	it("just now", () => {
		assert.equal(isoToRelativeAge("2026-08-08T11:59:59Z", now), "just now");
	});
	it("future dates", () => {
		assert.equal(isoToRelativeAge("2027-01-01T00:00:00Z", now), "in the future");
	});
	it("unparseable stays as-is", () => {
		assert.equal(isoToRelativeAge("N/A"), "N/A");
	});
	it("singular form", () => {
		assert.equal(msToRelativeAge(3_600_000), "about 1 hour ago");
	});
});
