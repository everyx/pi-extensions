/**
 * Tests for model resolution (model.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
/** Minimal fake model registry for tests. */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../model.js";

function stubRegistry(models: { provider: string; id: string }[]): ModelRegistry {
	return {
		getAvailable: () => models as unknown as ReturnType<ModelRegistry["getAvailable"]>,
		find: () => undefined,
	} as unknown as ModelRegistry;
}

describe("resolveModel", () => {
	const fallback = { provider: "anthropic", id: "claude-sonnet-4" };
	const registry = stubRegistry([
		{ provider: "anthropic", id: "claude-sonnet-4" },
		{ provider: "openai", id: "gpt-4o" },
		{ provider: "google", id: "gemini-2.0-flash" },
	]);

	it("returns fallback when no model specified", () => {
		const r = resolveModel(registry, fallback, undefined);
		assert.equal(r.model, "anthropic/claude-sonnet-4");
		assert.equal(r.error, undefined);
	});

	it("returns fallback when no model specified and fallback is null", () => {
		const r = resolveModel(registry, null, undefined);
		assert.equal(r.model, undefined);
	});

	it("resolves exact provider/model", () => {
		const r = resolveModel(registry, fallback, "openai/gpt-4o");
		assert.equal(r.model, "openai/gpt-4o");
		assert.equal(r.error, undefined);
	});

	it("resolves model name without provider", () => {
		const r = resolveModel(registry, fallback, "gemini-2.0-flash");
		assert.equal(r.model, "google/gemini-2.0-flash");
	});

	it("resolves partial model name match", () => {
		const r = resolveModel(registry, fallback, "sonnet");
		assert.equal(r.model, "anthropic/claude-sonnet-4");
	});

	it("resolves partial provider hint", () => {
		const r = resolveModel(registry, fallback, "openai/gpt");
		assert.equal(r.model, "openai/gpt-4o");
	});

	it("returns error when explicit model not found", () => {
		const r = resolveModel(registry, fallback, "nonexistent-model");
		assert.equal(r.model, undefined);
		assert(r.error?.includes("nonexistent-model"));
	});

	it("returns error when registry is empty", () => {
		const emptyReg = stubRegistry([]);
		const r = resolveModel(emptyReg, fallback, "anything");
		assert.equal(r.model, undefined);
		assert(r.error?.includes("No models available"));
	});

	it("treats dots/colons as separators matching hyphens", () => {
		const r = resolveModel(registry, fallback, "gemini:2.0:flash");
		assert.equal(r.model, "google/gemini-2.0-flash");
	});
});
