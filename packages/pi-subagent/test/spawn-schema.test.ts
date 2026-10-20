import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import { buildSpawnParamsSchema } from "../index.js";

/** Collect top-level property keys from a TypeBox object schema. */
function keys(schema: TSchema): string[] {
	return Object.keys((schema as { properties: Record<string, unknown> }).properties);
}

describe("buildSpawnParamsSchema", () => {
	it("exposes exactly the agreed parameters, in order", () => {
		assert.deepEqual(keys(buildSpawnParamsSchema()), [
			"prompt",
			"label",
			"model",
			"thinking",
			"tools",
			"timeoutMs",
			"resume",
			"persistent",
		]);
	});

	it("no spawn waits: there is no blocking switch to set", () => {
		assert.ok(!keys(buildSpawnParamsSchema()).includes("run_in_background"));
	});

	it("label is required — every spawn carries a short label", () => {
		const schema = buildSpawnParamsSchema() as unknown as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		assert.ok(schema.properties.label, "label present");
		assert.ok(schema.required?.includes("label"), "label required");
	});
});
