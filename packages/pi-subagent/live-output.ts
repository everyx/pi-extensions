/**
 * pi-subagent — live output routing: where a running agent's output goes.
 *
 * One rule, and it does not depend on how the agent was spawned:
 *   - the root widget hears about every update. It tracks background rows AND
 *     resident persistent rows, and a woken resident agent has a row and no
 *     card (its card closed when its spawn returned) — so the widget is the
 *     only surface its follow-up output can reach;
 *   - the tree telemetry hears about every update too: it folds into an open
 *     card, forwards up, or lands on the widget, per the 显示面统一规则;
 *   - the spawn card hears about it only when a foreground spawn has one, and
 *     only while its tool call runs.
 *
 * The widget and the tree ignore agents outside their surface, so telling them
 * costs nothing — and gating them on how the agent was spawned is the bug this
 * module exists to prevent.
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
