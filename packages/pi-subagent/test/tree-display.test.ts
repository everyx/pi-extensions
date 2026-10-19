import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTreeEvent } from "../event-interpret.js";
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

	it("activity and remove land on the same row", () => {
		const h = harness();
		h.openWidget();
		h.display.onTreeEvent({ op: "activity", id: "k1", activity: { kind: "tool", name: "bash", args: "ls" } });
		h.display.onTreeEvent({ op: "remove", id: "k1", status: "done" });
		assert.deepEqual(h.w.calls, ["activity:k1:tool", "remove:k1:done"]);
	});

	it("no widget (non-TUI root) → events are dropped, not thrown", () => {
		const h = harness();
		assert.doesNotThrow(() => h.display.onTreeEvent(addAt(0)));
		assert.deepEqual(h.w.calls, []);
	});
});
