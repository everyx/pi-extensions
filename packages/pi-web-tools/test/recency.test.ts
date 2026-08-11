/**
 * Tests for recency mapping (search/recency.ts) — pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	recencyToDays,
	recencyToExa,
	recencyToGoogle,
	recencyToParallel,
	recencyToPhrase,
	recencyToStartDate,
	recencyToTavily,
} from "../search/recency.js";

describe("recency", () => {
	it("maps filters to day counts", () => {
		assert.equal(recencyToDays("day"), 1);
		assert.equal(recencyToDays("week"), 7);
		assert.equal(recencyToDays("month"), 30);
		assert.equal(recencyToDays("year"), 365);
	});

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

	it("phrases for query enrichment", () => {
		assert.equal(recencyToPhrase("day"), "past 24 hours");
		assert.equal(recencyToPhrase("week"), "past week");
	});
});
