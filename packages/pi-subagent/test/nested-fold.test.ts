import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTreeEvent } from "../event-interpret.js";
import { createNestedFold, resolveTreeAnchor } from "../nested-fold.js";

const add = (id: string, status: "running" | "idle" = "running"): AgentTreeEvent => ({
	op: "add",
	id,
	title: id,
	startedAt: 1000,
	depth: 1,
	status,
});
const remove = (id: string, status: "done" | "failed" | "stopped"): AgentTreeEvent => ({
	op: "remove",
	id,
	status,
});
const activity: AgentTreeEvent = { op: "activity", id: "x", activity: { kind: "text", text: "hi" } };

describe("createNestedFold", () => {
	it("counts adds and removes; done n/total keeps ended items in total", () => {
		const f = createNestedFold();
		f.fold(add("a"));
		f.fold(add("b"));
		f.fold(remove("a", "done"));
		assert.deepEqual(f.snapshot(), { total: 2, running: 1, idle: 0, done: 1, failed: 0, stopped: 0 });
	});

	it("ignores activity events", () => {
		const f = createNestedFold();
		f.fold(activity);
		assert.deepEqual(f.snapshot(), { total: 0, running: 0, idle: 0, done: 0, failed: 0, stopped: 0 });
	});

	it("persistent double add transitions running → idle without re-counting", () => {
		const f = createNestedFold();
		f.fold(add("p", "running"));
		f.fold(add("p", "idle")); // resident
		assert.deepEqual(f.snapshot(), { total: 1, running: 0, idle: 1, done: 0, failed: 0, stopped: 0 });
	});

	it("unknown-id removes are no-ops (no negative running, no phantom counts)", () => {
		const f = createNestedFold();
		f.fold(remove("ghost", "failed"));
		assert.deepEqual(f.snapshot(), { total: 0, running: 0, idle: 0, done: 0, failed: 0, stopped: 0 });
	});

	it("remove of an idle resident counts toward its result bucket", () => {
		const f = createNestedFold();
		f.fold(add("p", "running"));
		f.fold(add("p", "idle"));
		f.fold(remove("p", "stopped"));
		assert.deepEqual(f.snapshot(), { total: 1, running: 0, idle: 0, done: 0, failed: 0, stopped: 1 });
	});

	it("snapshot is a copy — folding after snapshot does not mutate it", () => {
		const f = createNestedFold();
		f.fold(add("a"));
		const s = f.snapshot();
		f.fold(remove("a", "done"));
		assert.equal(s.running, 1);
		assert.equal(f.snapshot().done, 1);
	});
});

describe("resolveTreeAnchor — 显示面统一规则 decision table", () => {
	it("non-root always forwards, regardless of edge kind or card state", () => {
		assert.equal(resolveTreeAnchor({ hasParent: true, foregroundEdge: true, cardClosed: false }), "forward");
		assert.equal(resolveTreeAnchor({ hasParent: true, foregroundEdge: false, cardClosed: true }), "forward");
	});

	it("root + open foreground card folds the subtree into the card", () => {
		assert.equal(resolveTreeAnchor({ hasParent: false, foregroundEdge: true, cardClosed: false }), "fold");
	});

	it("root + background child lands on the widget", () => {
		assert.equal(resolveTreeAnchor({ hasParent: false, foregroundEdge: false, cardClosed: false }), "widget");
	});

	it("a closed card never folds — persistent children surface on the widget", () => {
		assert.equal(resolveTreeAnchor({ hasParent: false, foregroundEdge: true, cardClosed: true }), "widget");
	});
});
