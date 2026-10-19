import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTreeAnchor } from "../tree-anchor.js";

describe("resolveTreeAnchor — where a tree event lands", () => {
	it("non-root forwards, so the root owns every surface", () => {
		assert.equal(resolveTreeAnchor({ hasParent: true }), "forward");
	});

	it("root applies it to the widget", () => {
		assert.equal(resolveTreeAnchor({ hasParent: false }), "widget");
	});
});
