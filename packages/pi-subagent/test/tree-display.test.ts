import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTreeEvent } from "../event-interpret.js";
import { createSubtreeDisplay } from "../tree-display.js";

/** Recording fake: captures every widget mutation through the real surface. */
function fakeWidget() {
	const calls: string[] = [];
	return {
		calls,
		addNested(a: { agentId: string; indent: number }) {
			calls.push(`add:${a.agentId}@${a.indent}`);
		},
		updateActivity(id: string) {
			calls.push(`activity:${id}`);
		},
		remove(id: string, status: string) {
			calls.push(`remove:${id}:${status}`);
		},
		add() {},
		setStatus() {},
		dispose() {},
	};
}

function harness(opts: { hasParent?: boolean; foregroundEdge?: boolean } = {}) {
	const w = fakeWidget();
	let exists = false;
	const forward: AgentTreeEvent[] = [];
	let folds = 0;
	const display = createSubtreeDisplay({
		hasParent: opts.hasParent ?? false,
		foregroundEdge: opts.foregroundEdge ?? true,
		getWidget: () => (exists ? (w as never) : undefined),
		forward: (e) => forward.push(e),
		onFold: () => folds++,
	});
	return {
		display,
		w,
		forward,
		openWidget() {
			exists = true;
		},
		foldCount: () => folds,
	};
}

const addAt = (depth: number) =>
	({ op: "add", id: "k1", title: "K", startedAt: 1, depth, status: "running" }) as AgentTreeEvent;

describe("createSubtreeDisplay — 显示面统一规则 full chain", () => {
	it("root + open foreground card → folds, refreshes card, never touches widget", () => {
		const h = harness();
		h.display.onTreeEvent(addAt(0));
		assert.deepEqual(h.w.calls, [], "widget untouched");
		assert.equal(h.foldCount(), 1);
		assert.deepEqual(h.display.nested(), { total: 1, running: 1, idle: 0, done: 0, failed: 0, stopped: 0 });
	});

	it("non-root → forwards with depth + 1, no folding", () => {
		const h = harness({ hasParent: true });
		h.display.onTreeEvent(addAt(1));
		assert.equal(h.foldCount(), 0);
		assert.deepEqual(h.forward, [{ op: "add", id: "k1", title: "K", startedAt: 1, depth: 2, status: "running" }]);
	});

	it("root + background child → widget rows at forwarded depth", () => {
		const h = harness({ foregroundEdge: false });
		h.openWidget();
		h.display.onTreeEvent(addAt(2));
		assert.deepEqual(h.w.calls, ["add:k1@2"]);
		assert.deepEqual(h.display.nested().total, 0);
	});

	it("closed card → persistent child's events surface on the widget instead", () => {
		const h = harness({ foregroundEdge: true });
		h.openWidget();
		h.display.onTreeEvent(addAt(0)); // folded while open
		h.display.closeCard();
		h.display.onTreeEvent({ op: "remove", id: "k1", status: "done" }); // post-return ending
		assert.ok(h.w.calls.includes("remove:k1:done"), `widget got: ${h.w.calls}`);
	});
});
