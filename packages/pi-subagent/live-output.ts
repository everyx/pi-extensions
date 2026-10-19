/**
 * pi-subagent — live output routing: where a running agent's output goes.
 *
 * Every update goes to the root widget (which owns the row) and to the tree
 * telemetry (which forwards it up or applies it, per the 显示面统一规则).
 * Both ignore agents outside their surface, so telling them unconditionally
 * costs nothing — and gating them on how the agent was spawned is the bug
 * this module exists to prevent.
 */

import type { AgentActivity } from "./event-interpret.js";

export interface LiveAgent {
	agentId: string;
	getLatestActivity(): AgentActivity | undefined;
}

export interface LiveSurfaces {
	/** The widget that holds the agent's row — a GETTER, because the widget is
	 *  created on first use (lazily, once per session): a captured reference
	 *  would be null for every update before that. */
	getWidget?: () => { updateActivity(agentId: string, activity: AgentActivity | undefined): void } | undefined;
	/** Telemetry for the agent's subtree (fold / forward / widget). */
	tree: { activity(agent: LiveAgent): void };
}

/** The spawn tool's own card. Absent for a background spawn: no card exists. */
export interface CardSink {
	/** A streamed text delta (the card keeps its own accumulation). */
	delta(text: string): void;
	/** A thinking/tool transition. */
	activity(activity: AgentActivity): void;
}

export interface LiveChannels {
	onDelta(agent: LiveAgent, delta: string): void;
	onActivity(agent: LiveAgent, activity: AgentActivity): void;
}

export function createLiveChannels(opts: { surfaces: LiveSurfaces; card?: CardSink }): LiveChannels {
	/** Both surfaces, every update, whatever the spawn looked like. */
	const publish = (agent: LiveAgent, activity: AgentActivity | undefined): void => {
		opts.surfaces.getWidget?.()?.updateActivity(agent.agentId, activity);
		opts.surfaces.tree.activity(agent);
	};

	return {
		onDelta(agent, delta) {
			publish(agent, agent.getLatestActivity());
			opts.card?.delta(delta);
		},
		onActivity(agent, activity) {
			publish(agent, activity);
			// Text arrives through onDelta — the card does not need it twice.
			if (activity.kind !== "text") opts.card?.activity(activity);
		},
	};
}
