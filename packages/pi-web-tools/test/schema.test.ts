/**
 * Tests for the LLM-facing web_search schema (schema.ts): the parameter set
 * is a deliberate contract — the four-API-channel intent intersection (bsk fuse included) plus the
 * locale override. This test pins it so no param can silently appear or
 * vanish.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWebSearchSchema } from "../schema.js";

describe("web_search schema", () => {
	it("exposes exactly the five agreed params, in order", () => {
		const schema = buildWebSearchSchema();
		assert.deepEqual(Object.keys(schema.properties), [
			"query",
			"recency",
			"allowed_domains",
			"blocked_domains",
			"locale",
		]);
	});

	it("only query is required", () => {
		const schema = buildWebSearchSchema();
		assert.deepEqual(schema.required, ["query"]);
	});

	it("no engine param — routing is not the LLM's business", () => {
		const schema = buildWebSearchSchema();
		assert.equal((schema.properties as Record<string, unknown>).engine, undefined);
	});
});
