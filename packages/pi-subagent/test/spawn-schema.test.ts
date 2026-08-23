import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import { buildSpawnParamsSchema, deriveTitle } from "../index.js";

/** Collect top-level property keys from a TypeBox object schema. */
function keys(schema: TSchema): string[] {
	return Object.keys((schema as { properties: Record<string, unknown> }).properties);
}

describe("buildSpawnParamsSchema", () => {
	it("root session: full parameter set", () => {
		const k = keys(buildSpawnParamsSchema(false));
		for (const name of [
			"prompt",
			"title",
			"model",
			"thinking",
			"tools",
			"timeoutMs",
			"run_in_background",
			"persistent",
		]) {
			assert.ok(k.includes(name), `missing ${name}`);
		}
	});

	it("title is optional — omitted titles derive from the prompt, never block a spawn", () => {
		const schema = buildSpawnParamsSchema(false) as unknown as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		assert.ok(schema.properties.title, "title present");
		assert.ok(!schema.required?.includes("title"), "title not required");
	});

	it("sub-agent: only run_in_background hidden, persistent stays available", () => {
		const k = keys(buildSpawnParamsSchema(true));
		assert.ok(!k.includes("run_in_background"));
		for (const name of ["prompt", "title", "model", "thinking", "tools", "timeoutMs", "persistent"]) {
			assert.ok(k.includes(name), `missing ${name}`);
		}
	});
});

describe("deriveTitle", () => {
	it("takes the prompt's first line", () => {
		assert.equal(deriveTitle("fix login redirect\nthen run tests"), "fix login redirect");
	});

	it("caps long first lines with an ellipsis", () => {
		const r = deriveTitle("x".repeat(200));
		assert.ok(r.length < 200 && r.endsWith("…"), `got ${r.length} chars`);
	});

	it("handles missing/blank prompts safely", () => {
		assert.equal(deriveTitle(undefined), "");
		assert.equal(deriveTitle(""), "");
	});
});
