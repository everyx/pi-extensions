import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import { buildSpawnParamsSchema } from "../index.js";

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

	it("sub-agent: only run_in_background hidden, persistent stays available", () => {
		const k = keys(buildSpawnParamsSchema(true));
		assert.ok(!k.includes("run_in_background"));
		for (const name of ["prompt", "title", "model", "thinking", "tools", "timeoutMs", "persistent"]) {
			assert.ok(k.includes(name), `missing ${name}`);
		}
	});
});
