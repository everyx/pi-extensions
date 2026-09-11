/**
 * Tests for live output routing (live-output.ts): which surfaces hear about a
 * running agent, and the rule that this does not depend on how it was spawned.
 *
 * The bug this pins: a persistent agent spawned in the foreground has a widget
 * row once it becomes resident and no card (its card closed when the spawn
 * returned). Routing its follow-up output to the card alone — the foreground
 * branch — leaves a woken agent silent on every surface it still has.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentActivity } from "../event-interpret.js";
import { type CardSink, createLiveChannels, type LiveAgent, type LiveSurfaces } from "../live-output.js";

const agent = (latest?: AgentActivity): LiveAgent => ({
	agentId: "a1",
	getLatestActivity: () => latest,
});

/** Recording fakes for the two surfaces the widget and the tree provide. */
function surfaces() {
	const calls: string[] = [];
	const widget = {
		updateActivity(agentId: string, activity: AgentActivity | undefined) {
			calls.push(`widget:${agentId}:${activity?.kind ?? "none"}`);
		},
	};
	const tree = {
		activity(a: LiveAgent) {
			calls.push(`tree:${a.agentId}`);
		},
	};
	return { calls, surfaces: { getWidget: () => widget, tree } satisfies LiveSurfaces };
}

function card() {
	const calls: string[] = [];
	const sink: CardSink = {
		delta: (text) => calls.push(`card:delta:${text}`),
		activity: (activity) => calls.push(`card:activity:${activity.kind}`),
	};
	return { calls, sink };
}

describe("createLiveChannels — 实时输出落到哪些显示面", () => {
	it("前台 spawn（卡片开着）：widget 与 tree 同样收到 —— 唤醒的 resident agent 只有它们", () => {
		const s = surfaces();
		const c = card();
		const live = createLiveChannels({ surfaces: s.surfaces, card: c.sink });

		live.onDelta(agent({ kind: "text", text: "hi" }), "hi");

		assert.deepEqual(s.calls, ["widget:a1:text", "tree:a1"], "卡片之外两个面都要喂");
		assert.deepEqual(c.calls, ["card:delta:hi"]);
	});

	it("后台 spawn（没有卡片）：widget 与 tree 收到，卡片不参与", () => {
		const s = surfaces();
		const live = createLiveChannels({ surfaces: s.surfaces });

		live.onDelta(agent({ kind: "text", text: "hi" }), "hi");

		assert.deepEqual(s.calls, ["widget:a1:text", "tree:a1"]);
	});

	it("thinking/tool 走 activity 通道：卡片收到，text 不重复进卡片", () => {
		const s = surfaces();
		const c = card();
		const live = createLiveChannels({ surfaces: s.surfaces, card: c.sink });

		live.onActivity(agent({ kind: "tool", name: "bash", args: "ls" }), { kind: "tool", name: "bash", args: "ls" });
		live.onActivity(agent({ kind: "text", text: "x" }), { kind: "text", text: "x" });

		assert.deepEqual(s.calls, ["widget:a1:tool", "tree:a1", "widget:a1:text", "tree:a1"]);
		assert.deepEqual(c.calls, ["card:activity:tool"], "text 由 onDelta 送，卡片不重复");
	});

	it("widget 每次现取：构造时还没有、后来才建出来，后续更新要到位", () => {
		const calls: string[] = [];
		let widget: { updateActivity(id: string, a: AgentActivity | undefined): void } | undefined;
		const live = createLiveChannels({
			surfaces: { getWidget: () => widget, tree: { activity: (a) => calls.push(`tree:${a.agentId}`) } },
		});

		live.onDelta(agent({ kind: "text", text: "a" }), "a"); // 此刻 widget 还不存在
		widget = { updateActivity: (id, a) => calls.push(`widget:${id}:${a?.kind ?? "none"}`) };
		live.onDelta(agent({ kind: "text", text: "b" }), "b");

		// Second update: widget first (it is in hand now), then the tree.
		assert.deepEqual(calls, ["tree:a1", "widget:a1:text", "tree:a1"], "构造期捕获引用会永远拿不到 widget");
	});

	it("没有 widget（非 TUI）：tree 照旧，不炸", () => {
		const calls: string[] = [];
		const live = createLiveChannels({ surfaces: { tree: { activity: (a) => calls.push(`tree:${a.agentId}`) } } });

		live.onDelta(agent({ kind: "text", text: "hi" }), "hi");

		assert.deepEqual(calls, ["tree:a1"]);
	});

	it("agent 还没吐过内容（getLatestActivity 为空）：旧行为一致，不伪造活动", () => {
		const s = surfaces();
		const c = card();
		const live = createLiveChannels({ surfaces: s.surfaces, card: c.sink });

		live.onDelta(agent(undefined), "hi");

		assert.deepEqual(s.calls, ["widget:a1:none", "tree:a1"]);
		assert.deepEqual(c.calls, ["card:delta:hi"]);
	});
});
