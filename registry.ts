/**
 * pi-subagent — AgentRegistry.
 *
 * Owns the set of running background agents and the "what happens when an
 * agent finishes" policy — bookkeeping that used to live inline in index.ts
 * tool executes (registry map + widget row + child process kept in sync in
 * three call sites: Agent.execute, AgentControl.execute, session_shutdown).
 *
 * The registry depends on narrow seams — a notify callback and a widget
 * surface — so the completion policy is unit-testable without a pi API or a
 * TUI. AgentProcess satisfies RegisteredAgent structurally; index.ts adapts
 * the TUI widget via WidgetSurface.
 *
 * Policy (kept verbatim from the previous inline wiring):
 *   - AgentControl.stop is a deliberate user action → no notification (B6).
 *   - Timeout/hard-stop completions still notify with status "stopped" (B5).
 *   - Every terminal path cleans up exactly once (remove is idempotent).
 */

import type { AgentCompletion } from "./agent-process.js";

/** Narrow agent surface the registry needs — AgentProcess satisfies it. */
export interface RegisteredAgent {
	readonly agentId: string;
	readonly title: string;
	stoppedByControl: boolean;
	stop(): Promise<void>;
}

/** Narrow widget surface — index.ts adapts the TUI AgentWidget to it. */
export interface WidgetSurface {
	add(agent: RegisteredAgent): void;
	remove(agentId: string): void;
	dispose(): void;
}

export interface AgentRegistryDeps {
	/** Deliver a completion notification (index.ts wraps pi.sendMessage). */
	notify: (agent: RegisteredAgent, completion: AgentCompletion) => Promise<void> | void;
	/** Lazy widget access — null in non-TUI modes. */
	getWidget?: () => WidgetSurface | null;
}

export class AgentRegistry {
	private readonly agents = new Map<string, RegisteredAgent>();
	private readonly notify: AgentRegistryDeps["notify"];
	private readonly getWidget: NonNullable<AgentRegistryDeps["getWidget"]>;

	constructor(deps: AgentRegistryDeps) {
		this.notify = deps.notify;
		this.getWidget = deps.getWidget ?? (() => null);
	}

	/** Track a background agent: registry entry + widget row. */
	register(agent: RegisteredAgent): void {
		this.agents.set(agent.agentId, agent);
		this.getWidget()?.add(agent);
	}

	lookup(agentId: string): RegisteredAgent | undefined {
		return this.agents.get(agentId);
	}

	/**
	 * Completion policy + cleanup, single choke point. Notifies unless the
	 * stop was user-controlled; always removes the bookkeeping and stops the
	 * child (idempotent — safe for never-registered spawn failures and for
	 * completions arriving after stopAndRemove).
	 */
	async complete(agent: RegisteredAgent, completion: AgentCompletion): Promise<void> {
		try {
			if (!agent.stoppedByControl) await this.notify(agent, completion);
		} finally {
			this.remove(agent.agentId);
			await agent.stop().catch(() => {});
		}
	}

	/** AgentControl.stop path: graceful stop + removal (no notification). */
	async stopAndRemove(agentId: string): Promise<void> {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		await agent.stop().catch(() => {});
		this.remove(agentId);
	}

	/** Stop everything (session shutdown). */
	async shutdown(): Promise<void> {
		for (const agent of this.agents.values()) {
			void agent.stop();
		}
		this.agents.clear();
		this.getWidget()?.dispose();
	}

	private remove(agentId: string): void {
		// Only touch the widget for agents we actually tracked — a spawn-
		// failure completion never registered, so delete() returns false and
		// the widget stays untouched (no spurious requestRender).
		if (this.agents.delete(agentId)) this.getWidget()?.remove(agentId);
	}
}
