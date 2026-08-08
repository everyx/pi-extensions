/**
 * Tests for channel capability matrix + routing (search/channels.ts).
 *
 * Pure functions — no network, no process spawning.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	channelCapabilities,
	DEFAULT_CHANNEL_ORDER,
	parseChannelOrder,
	requestedCapabilities,
	route,
	satisfies,
} from "../search/channels.js";
import type { WebSearchParams } from "../types.js";

describe("channelCapabilities", () => {
	it("exa/parallel have no operators/locale", () => {
		assert.deepEqual(channelCapabilities("exa"), { domains: true, recency: true, locale: false, operators: false });
		assert.deepEqual(channelCapabilities("parallel"), {
			domains: true,
			recency: true,
			locale: false,
			operators: false,
		});
	});
	it("tavily supports operators (site:/boolean/quotes) and locale", () => {
		assert.deepEqual(channelCapabilities("tavily"), { domains: true, recency: true, locale: true, operators: true });
	});
	it("bsk is the full-capability channel", () => {
		assert.deepEqual(channelCapabilities("bsk"), { domains: true, recency: true, locale: true, operators: true });
	});
	it("grounding supports nothing structured", () => {
		assert.deepEqual(channelCapabilities("grounding"), {
			domains: false,
			recency: false,
			locale: false,
			operators: false,
		});
	});
});

describe("requestedCapabilities", () => {
	it("plain query requests nothing", () => {
		assert.deepEqual(requestedCapabilities({ query: "hello" }), {
			domains: false,
			recency: false,
			locale: false,
			operators: false,
		});
	});
	it("domains param requests domains", () => {
		assert.deepEqual(requestedCapabilities({ query: "q", allowed_domains: ["github.com"] }).domains, true);
		assert.deepEqual(requestedCapabilities({ query: "q", blocked_domains: ["reddit.com"] }).domains, true);
	});
	it("engine != auto requests operators (the gate)", () => {
		assert.deepEqual(requestedCapabilities({ query: "q", engine: "google" }).operators, true);
		assert.deepEqual(requestedCapabilities({ query: "q", engine: "auto" }).operators, false);
	});
});

describe("route", () => {
	const all = ["exa", "tavily", "parallel", "bsk", "grounding"] as const;

	it("plain query routes to the cheapest available API channel (exa first)", () => {
		assert.deepEqual(route({ query: "q" }, [...all]), { channel: "exa" });
	});

	it("respects the configured channel order", () => {
		assert.deepEqual(route({ query: "q" }, [...all], ["tavily", "exa"]), { channel: "tavily" });
		assert.deepEqual(route({ query: "q" }, [...all], ["bsk", "exa"]), { channel: "bsk" });
	});

	it("skips unavailable channels", () => {
		assert.deepEqual(route({ query: "q" }, ["tavily", "parallel"]), { channel: "tavily" });
	});

	it("engine gate: engine != auto routes to bsk with that engine", () => {
		assert.deepEqual(route({ query: "q", engine: "google" }, [...all]), { channel: "bsk", engine: "google" });
		assert.deepEqual(route({ query: "q", engine: "baidu" }, [...all]), { channel: "bsk", engine: "baidu" });
	});

	it("engine gate errors when bsk is unavailable (no silent fallback)", () => {
		const result = route({ query: "q", engine: "google" }, ["exa", "tavily"]);
		assert.ok("error" in result);
		assert.match(result.error, /real-browser channel/);
		assert.deepEqual(result.unsatisfied, ["operators"]);
	});

	it("recency routes to a channel that supports it (grounding excluded)", () => {
		const result = route({ query: "q", recency: "week" }, ["exa", "grounding"]);
		assert.ok("channel" in result);
		assert.equal(result.channel, "exa");
	});

	it("locale routes past channels that lack locale support", () => {
		// exa/parallel lack locale; tavily and bsk have it.
		assert.deepEqual(route({ query: "q", locale: "zh-CN" }, ["exa", "parallel", "tavily"]), { channel: "tavily" });
		assert.deepEqual(route({ query: "q", locale: "zh-CN" }, ["exa", "parallel", "bsk"]), { channel: "bsk" });
	});

	it("grounding-only with structured capability → explicit error", () => {
		const result = route({ query: "q", recency: "day" }, ["grounding"]);
		assert.ok("error" in result);
		assert.deepEqual(result.unsatisfied, ["recency"]);
	});

	it("no available channel → explicit error naming unsatisfied capabilities", () => {
		const result = route({ query: "q", allowed_domains: ["x.com"], recency: "year" }, ["grounding"]);
		assert.ok("error" in result);
		assert.deepEqual(result.unsatisfied, ["domains", "recency"]);
	});
});

describe("satisfies", () => {
	it("grounding never satisfies structured requests", () => {
		assert.equal(satisfies("grounding", { domains: true, recency: false, locale: false, operators: false }), false);
		assert.equal(satisfies("grounding", { domains: false, recency: false, locale: false, operators: false }), true);
	});
});

describe("parseChannelOrder", () => {
	it("parses and dedupes, keeping order", () => {
		assert.deepEqual(parseChannelOrder("bsk,exa,bsk"), ["bsk", "exa"]);
	});
	it("rejects unknown channel names", () => {
		assert.deepEqual(parseChannelOrder("foo,exa"), ["exa"]);
	});
	it("empty/undefined → undefined (use default)", () => {
		assert.equal(parseChannelOrder(undefined), undefined);
		assert.equal(parseChannelOrder(""), undefined);
		assert.equal(parseChannelOrder("foo"), undefined);
	});
	it("default order is API-first", () => {
		assert.deepEqual(DEFAULT_CHANNEL_ORDER, ["exa", "tavily", "parallel", "bsk", "grounding"]);
	});
});

describe("route + params shapes", () => {
	it("accepts a full WebSearchParams object", () => {
		const params: WebSearchParams = {
			query: "rust",
			recency: "month",
			allowed_domains: ["docs.rs"],
			blocked_domains: ["crates.io"],
			locale: "en-US",
			engine: "auto",
		};
		const result = route(params, ["exa", "tavily", "bsk"]);
		assert.ok("channel" in result);
		assert.equal(result.channel, "tavily"); // exa lacks locale
	});
});
