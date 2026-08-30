/**
 * Tests for recency mapping (search/recency.ts) — pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	recencyToExa,
	recencyToMinutes,
	recencyToStartDate,
	recencyToTavily,
	recencyToTbs,
} from "../search/recency.js";

describe("recency", () => {
	it("start date is N days ago as ISO", () => {
		const now = new Date("2026-05-01T00:00:00Z");
		assert.equal(recencyToStartDate("week", now), "2026-04-24");
		assert.equal(recencyToExa("week", now), "2026-04-24");
	});

	it("TinyFish takes minutes", () => {
		assert.equal(recencyToMinutes("day"), 1440);
		assert.equal(recencyToMinutes("week"), 10_080);
		assert.equal(recencyToMinutes("month"), 43_200);
		assert.equal(recencyToMinutes("year"), 525_600);
	});

	it("Tavily takes the filter verbatim", () => {
		assert.equal(recencyToTavily("month"), "month");
	});

	it("tbs uses first letter (Firecrawl + bsk google)", () => {
		assert.equal(recencyToTbs("day"), "qdr:d");
		assert.equal(recencyToTbs("week"), "qdr:w");
		assert.equal(recencyToTbs("month"), "qdr:m");
		assert.equal(recencyToTbs("year"), "qdr:y");
	});
});
