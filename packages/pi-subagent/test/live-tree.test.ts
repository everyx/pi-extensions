import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiveTree } from "../live-tree.js";

describe("createLiveTree — lifecycle, independent of any UI", () => {
	it("tracks who is alive under whom", () => {
		const t = createLiveTree();
		t.add("a", "");
		t.add("b", "a");
		t.add("c", "b");

		assert.deepEqual(t.liveIds().sort(), ["a", "b", "c"]);
		assert.equal(t.hasLiveDescendants("a"), true, "a grandchild counts");
		assert.equal(t.hasLiveDescendants("b"), true);
		assert.equal(t.hasLiveDescendants("c"), false);
	});

	it("an agent with no children is not waiting on anything", () => {
		const t = createLiveTree();
		t.add("a", "");
		assert.equal(t.hasLiveDescendants("a"), false);
	});

	it("remove takes the whole subtree and reports it", () => {
		const t = createLiveTree();
		t.add("a", "");
		t.add("b", "a");
		t.add("c", "b");

		const removed = t.remove("a");
		assert.deepEqual(removed.sort(), ["a", "b", "c"]);
		assert.deepEqual(t.liveIds(), []);
	});

	it("removing only a leaf leaves its ancestors alive", () => {
		const t = createLiveTree();
		t.add("a", "");
		t.add("b", "a");
		assert.deepEqual(t.remove("b"), ["b"]);
		assert.equal(t.hasLiveDescendants("a"), false);
		assert.deepEqual(t.liveIds(), ["a"]);
	});

	it("waiting resolves when the last descendant goes away", async () => {
		const t = createLiveTree();
		t.add("a", "");
		t.add("b", "a");

		let drained = false;
		const waiting = t.whenDrained("a").then(() => {
			drained = true;
		});
		await Promise.resolve();
		assert.equal(drained, false, "b is still running");

		t.remove("b");
		await waiting;
		assert.equal(drained, true);
	});

	it("a drained agent resolves immediately", async () => {
		const t = createLiveTree();
		t.add("a", "");
		await t.whenDrained("a");
	});

	it("a removed waiter resolves instead of hanging forever", async () => {
		const t = createLiveTree();
		t.add("a", "");
		t.add("b", "a");
		const waiting = t.whenDrained("a");
		t.remove("a");
		await waiting;
	});

	it("observe() applies telemetry — add links the parent, remove cascades", () => {
		const t = createLiveTree();
		assert.deepEqual(
			t.observe({ op: "add", id: "b", label: "B", startedAt: 0, depth: 1, status: "running", parent: "a" }),
			{
				removed: [],
			},
		);
		t.add("a", "");
		assert.equal(t.hasLiveDescendants("a"), true);

		assert.deepEqual(t.observe({ op: "remove", id: "b", status: "done" }), { removed: ["b"] });
		assert.equal(t.hasLiveDescendants("a"), false);
	});

	it("activity events change nothing", () => {
		const t = createLiveTree();
		t.add("a", "");
		t.add("b", "a");
		assert.deepEqual(t.observe({ op: "activity", id: "b", activity: { kind: "text", text: "hi" } }), { removed: [] });
		assert.deepEqual(t.liveIds().sort(), ["a", "b"]);
	});

	it("an add without a parent (older reporter) does not invent one", () => {
		const t = createLiveTree();
		t.add("a", "");
		t.observe({ op: "add", id: "b", label: "B", startedAt: 0, depth: 1, status: "running" });
		assert.equal(t.hasLiveDescendants("a"), false, "no link — b is not under a");
		assert.deepEqual(t.liveIds().sort(), ["a", "b"]);
	});

	it("a removed id is a no-op, not a cascade", () => {
		const t = createLiveTree();
		t.add("a", "");
		assert.deepEqual(t.remove("ghost"), []);
	});
});
