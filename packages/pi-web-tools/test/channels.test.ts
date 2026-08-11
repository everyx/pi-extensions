/**
 * Tests for channel capability matrix + routing + enabled-set resolution
 * (search/channels.ts).
 *
 * Pure functions — no network, no process spawning.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	API_CHANNELS,
	channelCapabilities,
	DEFAULT_CHANNEL_ORDER,
	defaultEnginesFor,
	ENGINE_IDS,
	orderedCandidates,
	parseEnginesConfig,
	requestedCapabilities,
	resolveApiChannels,
	resolveEngines,
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
	it("tavily supports operators but no locale (country is not domain-level localization)", () => {
		assert.deepEqual(channelCapabilities("tavily"), { domains: true, recency: true, locale: false, operators: true });
	});
	it("bsk is the full-capability channel", () => {
		assert.deepEqual(channelCapabilities("bsk"), { domains: true, recency: true, locale: true, operators: true });
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

describe("enabled set (PI_WEB_TOOLS_ENGINES)", () => {
	it("parses api channels and engines, dropping unknowns and dups", () => {
		assert.deepEqual(parseEnginesConfig("exa,tavily,google,bing,exa,foo"), {
			api: ["exa", "tavily"],
			engines: ["google", "bing"],
		});
	});
	it("config may name only engines or only api channels", () => {
		assert.deepEqual(parseEnginesConfig("baidu"), { api: [], engines: ["baidu"] });
		assert.deepEqual(parseEnginesConfig("parallel"), { api: ["parallel"], engines: [] });
	});
	it("empty/undefined → undefined (caller uses defaults)", () => {
		assert.equal(parseEnginesConfig(undefined), undefined);
		assert.equal(parseEnginesConfig(""), undefined);
		assert.equal(parseEnginesConfig("foo,bar"), undefined);
	});
	it("default engines: google is the global fallback; localized langs add one", () => {
		assert.deepEqual(defaultEnginesFor("zh"), ["bing", "google"]); // baidu not default
		assert.deepEqual(defaultEnginesFor("ru"), ["yandex", "google"]);
		assert.deepEqual(defaultEnginesFor("en"), ["google"]);
		assert.deepEqual(defaultEnginesFor("ja"), ["google"]);
		assert.deepEqual(defaultEnginesFor("ko"), ["google"]);
	});
	it("resolveEngines: config wins, else the system-locale default", () => {
		assert.deepEqual(resolveEngines({ engines: ["baidu"] }, "en-US"), ["baidu"]);
		assert.deepEqual(resolveEngines(undefined, "zh-CN"), ["bing", "google"]);
		assert.deepEqual(resolveEngines(undefined, "ru-RU"), ["yandex", "google"]);
		assert.deepEqual(resolveEngines(undefined, "en-US"), ["google"]);
	});
	it("resolveApiChannels: config wins, else all", () => {
		assert.deepEqual(resolveApiChannels({ api: ["tavily"] }), ["tavily"]);
		assert.deepEqual(resolveApiChannels(undefined), [...API_CHANNELS]);
	});
	it("engine ids and api channels are disjoint", () => {
		assert.equal(
			ENGINE_IDS.some((e) => (API_CHANNELS as string[]).includes(e)),
			false,
		);
	});
});

describe("route", () => {
	const all = ["exa", "tavily", "parallel", "bsk"] as const;

	it("plain query routes to the cheapest available API channel (exa first)", () => {
		assert.deepEqual(route({ query: "q" }, [...all]), { channel: "exa" });
	});

	it("respects the configured order via options", () => {
		assert.deepEqual(route({ query: "q" }, [...all], { order: ["tavily", "exa"] }), { channel: "tavily" });
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

	it("engine gate errors when the engine is not in the enabled set — terse error, guidance in hint", () => {
		const result = route({ query: "q", engine: "yandex" }, [...all], { engines: ["google", "bing"] });
		assert.ok("error" in result);
		assert.equal(result.error, `engine "yandex" is not enabled.`);
		assert.equal(result.hint, `set PI_WEB_TOOLS_ENGINES to include "yandex"`);
	});

	it("auto bsk engine = enabled locale-priority engine", () => {
		// zh-CN priority bing > baidu > google, enabled set {bing, google} → bing.
		assert.deepEqual(route({ query: "q", locale: "zh-CN" }, ["bsk"], { engines: ["bing", "google"] }), {
			channel: "bsk",
			engine: "bing",
		});
		// no locale → google (SPEC: 两者都无 → google).
		assert.deepEqual(route({ query: "q" }, ["bsk"], { engines: ["bing", "google"] }), {
			channel: "bsk",
			engine: "google",
		});
	});

	it("auto bsk falls back to the first enabled engine when the priority is not enabled", () => {
		// zh-CN priority [bing, baidu, google] ∩ enabled [baidu] → baidu.
		assert.deepEqual(route({ query: "q", locale: "zh-CN" }, ["bsk"], { engines: ["baidu"] }), {
			channel: "bsk",
			engine: "baidu",
		});
		// zh-CN priority ∩ enabled [yandex] → first enabled engine (config-set full fallback).
		assert.deepEqual(route({ query: "q", locale: "zh-CN" }, ["bsk"], { engines: ["yandex"] }), {
			channel: "bsk",
			engine: "yandex",
		});
	});

	it("recency routes to a channel that supports it", () => {
		const result = route({ query: "q", recency: "week" }, ["exa", "tavily"]);
		assert.ok("channel" in result);
		assert.equal(result.channel, "exa");
	});

	it("locale routes past channels that lack locale support — only bsk is locale-capable", () => {
		// No api channel has locale; bsk is the only localization channel.
		assert.deepEqual(route({ query: "q", locale: "zh-CN" }, ["exa", "parallel", "bsk"]), {
			channel: "bsk",
			engine: "bing",
		});
		// Without bsk, a locale request fails explicitly (no weak-country fallback).
		const result = route({ query: "q", locale: "zh-CN" }, ["exa", "parallel", "tavily"]);
		assert.ok("error" in result);
		assert.deepEqual(result.unsatisfied, ["locale"]);
	});

	it("no available channel → explicit error naming unsatisfied capabilities", () => {
		const result = route({ query: "q", allowed_domains: ["x.com"], recency: "year" }, []);
		assert.ok("error" in result);
		assert.deepEqual(result.unsatisfied, ["domains", "recency"]);
	});
});

describe("satisfies", () => {
	it("bsk satisfies everything; exa lacks locale/operators", () => {
		const full = { domains: true, recency: true, locale: true, operators: true };
		assert.equal(satisfies("bsk", full), true);
		assert.equal(satisfies("exa", full), false);
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
		// exa/parallel lack locale and domains-locale combination; tavily lacks
		// locale; bsk covers everything → bsk with the locale-priority engine.
		const result = route(params, ["exa", "tavily", "bsk"]);
		assert.deepEqual(result, { channel: "bsk", engine: "google" });
	});

	it("runtime capability overrides apply (keyless Exa MCP has no domains)", () => {
		const mcpExa = { domains: false, recency: false, locale: false, operators: false };
		const staticResult = route({ query: "q", blocked_domains: ["x.com"] }, ["exa", "bsk"]);
		assert.ok("channel" in staticResult);
		assert.equal(staticResult.channel, "exa");
		const mcpResult = route({ query: "q", blocked_domains: ["x.com"] }, ["exa", "bsk"], {
			capabilities: { exa: mcpExa },
		});
		assert.ok("channel" in mcpResult);
		assert.equal(mcpResult.channel, "bsk");
		const onlyMcp = route({ query: "q", blocked_domains: ["x.com"] }, ["exa"], { capabilities: { exa: mcpExa } });
		assert.ok("error" in onlyMcp);
		assert.deepEqual(onlyMcp.unsatisfied, ["domains"]);
	});
});

describe("orderedCandidates", () => {
	const all = ["exa", "tavily", "parallel", "bsk"] as const;

	it("returns every usable channel in order", () => {
		assert.deepEqual(orderedCandidates({ query: "q" }, [...all]), [
			{ channel: "exa" },
			{ channel: "tavily" },
			{ channel: "parallel" },
			{ channel: "bsk", engine: "google" },
		]);
	});

	it("respects availability (only usable channels)", () => {
		assert.deepEqual(orderedCandidates({ query: "q" }, ["tavily", "bsk"]), [
			{ channel: "tavily" },
			{ channel: "bsk", engine: "google" },
		]);
	});

	it("bsk carries the enabled locale-priority engine", () => {
		assert.deepEqual(orderedCandidates({ query: "q", locale: "zh-CN" }, ["bsk"], { engines: ["bing", "google"] }), [
			{ channel: "bsk", engine: "bing" },
		]);
		assert.deepEqual(orderedCandidates({ query: "q", locale: "ru-RU" }, ["bsk"], { engines: ["yandex", "google"] }), [
			{ channel: "bsk", engine: "yandex" },
		]);
	});

	it("default order is API-first, bsk last", () => {
		assert.deepEqual(DEFAULT_CHANNEL_ORDER, ["exa", "tavily", "parallel", "bsk"]);
	});
});
