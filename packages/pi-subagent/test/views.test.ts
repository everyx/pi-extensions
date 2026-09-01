import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTitle, atId, titleFrom } from "../views.js";

test("atId adds @ exactly once", () => {
	assert.equal(atId("max"), "@max");
	// Literal @-form (the protocol routes on it) must never double.
	assert.equal(atId("@max"), "@max");
	assert.equal(atId("@parent"), "@parent");
});

test("titleFrom never renders @@ (double-prefix regression)", () => {
	// agent_send to "@parent": details.to keeps the literal @ (protocol routes
	// on it); the card title must show a single @.
	assert.equal(titleFrom({ result: { data: { to: "@parent", message: "hi" } }, args: {} }, "to"), "@parent");
	// Plain id gets the prefix added once, joined with the label.
	assert.equal(
		titleFrom({ result: { data: { to: "zoe", label: "Research schema" } }, args: {} }, "to"),
		"@zoe — Research schema",
	);
	// agent_stop not-found: executor puts the stripped id in details.agentId
	// (args key is snake_case agent_id — titleFrom only reads details + camel).
	assert.equal(titleFrom({ result: { data: { agentId: "max", error: "x" } }, args: {} }, "agentId"), "@max");
});

test("agentTitle: @id — label (widget rows and notification cards share it)", () => {
	assert.equal(agentTitle("max", "check CI"), "@max — check CI");
});
