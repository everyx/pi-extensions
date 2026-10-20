import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTreeEvent } from "../event-interpret.js";
import { createLiveTree } from "../live-tree.js";
import { createSubtreeDisplay } from "../tree-display.js";

/** Fake widget surface — records what the display applies to it. */
function fakeWidget() {
	const calls: string[] = [];
	const nested: Array<{ agentId: string; parentId?: string; indent: number }> = [];
	return {
		calls,
		nested,
		addNested(a: { agentId: string; parentId?: string; indent: number }) {
			nested.push(a);
			calls.push(`add:${a.agentId}@${a.indent}`);
		},
		updateActivity(id: string, activity: { kind: string }) {
			calls.push(`activity:${id}:${activity.kind}`);
		},
		remove(id: string, status: string) {
			calls.push(`remove:${id}:${status}`);
		},
		add() {},
		setStatus() {},
		dispose() {},
	};
}

function harness(opts: { hasParent?: boolean } = {}) {
	const w = fakeWidget();
	let exists = false;
	const forward: AgentTreeEvent[] = [];
	const display = createSubtreeDisplay({
		hasParent: opts.hasParent ?? false,
		live: createLiveTree(),
		getWidget: () => (exists ? (w as never) : undefined),
		forward: (e) => forward.push(e),
	});
	return {
		display,
		w,
		forward,
		openWidget() {
			exists = true;
		},
	};
}

const addAt = (depth: number): Extract<AgentTreeEvent, { op: "add" }> => ({
	op: "add",
	id: "k1",
	label: "K",
	startedAt: 1,
	depth,
	status: "running",
});

describe("createSubtreeDisplay", () => {
	it("non-root → forwards with depth + 1, never touches the widget", () => {
		const h = harness({ hasParent: true });
		h.openWidget();
		h.display.onTreeEvent(addAt(1));
		assert.deepEqual(h.w.calls, []);
		assert.deepEqual(h.forward, [{ op: "add", id: "k1", label: "K", startedAt: 1, depth: 2, status: "running" }]);
	});

	it("root → widget rows at the forwarded depth", () => {
		const h = harness();
		h.openWidget();
		h.display.onTreeEvent(addAt(2));
		assert.deepEqual(h.w.calls, ["add:k1@2"]);
	});

	it("add carries the direct parent id through to the widget row", () => {
		const h = harness();
		h.openWidget();
		h.display.onTreeEvent({ ...addAt(1), parent: "a" });
		assert.equal(h.w.nested[0]?.parentId, "a");
	});

	it("activity lands on the row; remove drops the row the live tree reports", () => {
		const h = harness();
		h.openWidget();
		h.display.onTreeEvent(addAt(1));
		h.display.onTreeEvent({ op: "activity", id: "k1", activity: { kind: "tool", name: "bash", args: "ls" } });
		h.display.onTreeEvent({ op: "remove", id: "k1", status: "done" });
		assert.deepEqual(h.w.calls, ["add:k1@1", "activity:k1:tool", "remove:k1:done"]);
	});

	it("a removal cascades: rows for dead descendants go too", () => {
		const h = harness();
		h.openWidget();
		h.display.onTreeEvent({ ...addAt(1), id: "parent" });
		h.display.onTreeEvent({ ...addAt(2), id: "child", parent: "parent" });
		h.w.calls.length = 0;

		h.display.onTreeEvent({ op: "remove", id: "parent", status: "done" });
		assert.deepEqual(h.w.calls.sort(), ["remove:child:stopped", "remove:parent:done"]);
	});

	it("lifecycle is tracked even when the display is only forwarding (rpc sub-agent)", () => {
		// This is the review's blocker: a sub-agent has no widget, so a display-
		// driven drain rule answered "nothing is alive under me" and tore the
		// child down. The live tree must be updated whatever the anchor is.
		const live = createLiveTree();
		live.add("self", "");
		const display = createSubtreeDisplay({
			hasParent: true,
			live,
			getWidget: () => undefined, // rpc: no TUI at all
			forward: () => {},
		});
		display.onTreeEvent({ ...addAt(1), id: "child", parent: "self" });
		assert.equal(live.hasLiveDescendants("self"), true);
	});

	it("no widget (non-TUI root) → events are dropped, not thrown", () => {
		const h = harness();
		assert.doesNotThrow(() => h.display.onTreeEvent(addAt(0)));
		assert.deepEqual(h.w.calls, []);
	});
});
