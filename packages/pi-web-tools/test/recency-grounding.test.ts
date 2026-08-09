/**
 * Tests for recency mapping (search/recency.ts) and grounding endpoint
 * detection (search/grounding.ts) — pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundingEndpointFor, isGroundingAvailable, modelSupportsGrounding } from "../search/grounding.js";
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

describe("groundingEndpointFor", () => {
	it("recognizes official endpoints (grounding lives on the endpoint, not the model)", () => {
		assert.equal(groundingEndpointFor("openai", "https://api.openai.com/v1", "gpt-5.6")?.kind, "openai");
		assert.equal(
			groundingEndpointFor("anthropic", "https://api.anthropic.com", "claude-sonnet-4-5")?.kind,
			"anthropic",
		);
		assert.equal(
			groundingEndpointFor("gemini", "https://generativelanguage.googleapis.com", "gemini-3-flash")?.kind,
			"gemini",
		);
		assert.equal(
			groundingEndpointFor("deepseek", "https://api.deepseek.com/anthropic", "deepseek-v4-flash")?.kind,
			"deepseek",
		);
		assert.equal(groundingEndpointFor("openrouter", "https://openrouter.ai/api/v1", "gpt-5.6")?.kind, "openrouter");
	});

	it("relays (OpenCode Zen / self-hosted) are NOT grounding-capable — same model, different endpoint", () => {
		// Same model name, relay endpoint: no grounding.
		assert.equal(groundingEndpointFor("opencode", "https://opencode.ai/zen", "gpt-5.6"), null);
		assert.equal(groundingEndpointFor("ollama", "http://localhost:11434/v1", "llama-4"), null);
		assert.equal(groundingEndpointFor("vllm", "http://localhost:8000/v1", "qwen3"), null);
	});

	it("deepseek redirects to the Anthropic-compatible endpoint (pi uses OpenAI format)", () => {
		// pi drives DeepSeek via openai-completions at api.deepseek.com — the
		// server-side web search only exists on the /anthropic endpoint.
		const ep = groundingEndpointFor("deepseek", "https://api.deepseek.com", "deepseek-v4-flash");
		assert.ok(ep);
		assert.equal(ep.kind, "deepseek");
		assert.equal(ep.baseUrl, "https://api.deepseek.com/anthropic");
	});

	it("provider name match works even with generic baseUrl", () => {
		assert.equal(
			groundingEndpointFor("deepseek", "https://custom-proxy.example.com", "deepseek-v4-pro")?.kind,
			"deepseek",
		);
	});

	it("unknown providers → null", () => {
		assert.equal(groundingEndpointFor("custom", "https://example.com/v1", "model-x"), null);
	});
});

describe("modelSupportsGrounding", () => {
	it("openai: gpt-5 / gpt-4.1 / gpt-4o only", () => {
		assert.equal(modelSupportsGrounding("openai", "gpt-5.6"), true);
		assert.equal(modelSupportsGrounding("openai", "gpt-4.1-mini"), true);
		assert.equal(modelSupportsGrounding("openai", "gpt-4o"), true);
		assert.equal(modelSupportsGrounding("openai", "gpt-4-turbo"), false);
	});
	it("anthropic: claude models", () => {
		assert.equal(modelSupportsGrounding("anthropic", "claude-sonnet-4-5"), true);
		assert.equal(modelSupportsGrounding("anthropic", "gpt-5.6"), false);
	});
	it("gemini: 3 / 2.5 / 2.0 series", () => {
		assert.equal(modelSupportsGrounding("gemini", "gemini-3-flash"), true);
		assert.equal(modelSupportsGrounding("gemini", "gemini-2.5-pro"), true);
		assert.equal(modelSupportsGrounding("gemini", "gemini-2.0-flash"), true);
		assert.equal(modelSupportsGrounding("gemini", "gemini-1.5-pro"), false);
	});
	it("deepseek: v4-pro / v4-flash only (server-side search on their infra)", () => {
		assert.equal(modelSupportsGrounding("deepseek", "deepseek-v4-pro"), true);
		assert.equal(modelSupportsGrounding("deepseek", "deepseek-v4-flash"), true);
		assert.equal(modelSupportsGrounding("deepseek", "deepseek-chat"), false);
		assert.equal(modelSupportsGrounding("deepseek", "claude-sonnet-4-5"), false);
	});
	it("openrouter: any tool-calling model (Exa fallback)", () => {
		assert.equal(modelSupportsGrounding("openrouter", "gpt-5.6"), true);
		assert.equal(modelSupportsGrounding("openrouter", "anything-else"), true);
	});
});

describe("isGroundingAvailable", () => {
	it("true for official endpoints", () => {
		assert.equal(isGroundingAvailable("openai", "https://api.openai.com/v1", "gpt-5.6"), true);
	});
	it("false for relays/self-hosted", () => {
		assert.equal(isGroundingAvailable("opencode", "https://opencode.ai/zen", "gpt-5.6"), false);
	});
});
