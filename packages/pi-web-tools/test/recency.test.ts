/**
 * Tests for recency mapping (search/recency.ts) — pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	recencyToExa,
	recencyToGoogle,
	recencyToParallel,
	recencyToStartDate,
	recencyToTavily,
} from "../search/recency.js";

describe("recency", () => {
	it("start date is N days ago as ISO", () => {
		const now = new Date("2026-05-01T00:00:00Z");
		assert.equal(recencyToStartDate("week", now), "2026-04-24");
		assert.equal(recencyToExa("week", now), "2026-04-24");
		assert.equal(recencyToParallel("week", now), "2026-04-24");
	});

	it("Tavily takes the filter verbatim", () => {
		assert.equal(recencyToTavily("month"), "month");
	});

	it("google tbs uses first letter", () => {
		assert.equal(recencyToGoogle("day"), "qdr:d");
		assert.equal(recencyToGoogle("week"), "qdr:w");
		assert.equal(recencyToGoogle("month"), "qdr:m");
		assert.equal(recencyToGoogle("year"), "qdr:y");
	});
});
