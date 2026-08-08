/**
 * Tests for recency mapping (search/recency.ts) and grounding endpoint
 * detection (search/grounding.ts) — pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundingEndpointFor, isGroundingAvailable } from "../search/grounding.js";
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
			groundingEndpointFor("deepseek", "https://api.deepseek.com/anthropic", "deepseek-chat")?.kind,
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

	it("provider name match works even with generic baseUrl", () => {
		assert.equal(
			groundingEndpointFor("deepseek", "https://custom-proxy.example.com", "deepseek-chat")?.kind,
			"deepseek",
		);
	});

	it("unknown providers → null", () => {
		assert.equal(groundingEndpointFor("custom", "https://example.com/v1", "model-x"), null);
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
