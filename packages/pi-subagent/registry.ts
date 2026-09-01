/**
 * pi-subagent — AgentRegistry.
 *
 * Owns the set of running background agents and the "what happens when an
 * agent finishes" policy — bookkeeping that used to live inline in index.ts
 * tool executes (registry map + widget row + child process kept in sync in
 * three call sites: agent_spawn.execute, agent_stop.execute, session_shutdown).
 *
 * The registry depends on narrow seams — a notify callback and a widget
 * surface — so the completion policy is unit-testable without a pi API or a
 * TUI. AgentProcess satisfies RegisteredAgent structurally; index.ts adapts
 * the TUI widget via WidgetSurface.
 *
 * Policy (mirroring the previous inline wiring):
 *   - agent_stop is a deliberate user action → no notification (B6).
 *   - Timeout/hard-stop completions still notify with status "stopped" (B5).
 *   - Every terminal path cleans up exactly once (remove is idempotent).
 * Ordering note: the original wiring stopped the child *before* notifying on
 * the spawn-failure path (D15) but *after* notifying on the completion path;
 * complete() unifies both to notify → cleanup — no observable difference.
 */

import type { WidgetResult } from "@everyx/pi-ui/widget.js";
import type { AgentCompletion } from "./agent-process.js";
import { randomAgentName } from "./name-gen.js";
import { type AgentMessage, type RouteDecision, routeMessage } from "./protocol.js";

/** Narrow agent surface the registry needs — AgentProcess satisfies it. */
export interface RegisteredAgent {
	readonly agentId: string;
	readonly label: string;
	readonly model?: string;
	readonly thinking?: string;
	/** Resident after completion (idle) — explicit opt-in; complete() keeps it. */
	readonly persistent?: boolean;
	/** Deliver one in-tree message to this agent (AgentProcess.sendMessage). */
	sendMessage?: (text: string) => Promise<boolean>;
	stoppedByControl: boolean;
	stop(): Promise<void>;
}

/** Narrow widget surface — index.ts adapts the TUI AgentWidget to it. */
export interface WidgetSurface {
	/** `status` = the row's lifecycle state at registration (background settle = running;
	 *  foreground resident = idle — never a terminal status: the widget's terminal
	 *  cleanup removes such rows immediately). */
	add(agent: RegisteredAgent, status?: "running" | "idle"): void;
	/** `result` feeds the widget's lifetime progress meta; undefined = unknown. */
	remove(agentId: string, result?: WidgetResult): void;
	/** In-place status update (idle ⇄ running for persistent agents). */
	setStatus?(agentId: string, status: "idle" | "running"): void;
	dispose(): void;
}

interface AgentRegistryDeps {
	/** Deliver a completion notification (index.ts wraps pi.sendMessage). */
	notify: (agent: RegisteredAgent, completion: AgentCompletion) => Promise<void> | void;
	/** Lazy widget access — null in non-TUI modes. */
	getWidget?: () => WidgetSurface | null;
	/** This process is itself a child agent ("@parent" is deliverable upward). */
	hasParent?: boolean;
}

export class AgentRegistry {
	private readonly agents = new Map<string, RegisteredAgent>();
	private readonly notify: AgentRegistryDeps["notify"];
	private readonly getWidget: NonNullable<AgentRegistryDeps["getWidget"]>;
	private readonly hasParent: boolean;
	/** Names handed out this session — re-roll on collision (pool ~200). */
	private readonly usedNames = new Set<string>();

	constructor(deps: AgentRegistryDeps) {
		this.notify = deps.notify;
		this.getWidget = deps.getWidget ?? (() => null);
		this.hasParent = deps.hasParent ?? false;
	}

	/**
	 * Short human-name id (max, zoe, kai…) — the LLM-facing agent reference
	 * for this session (agent_send targets, notification JSON). Names read
	 * as names (not machine codes) and cost ~1 token each; uniqueness is
	 * this session's live set (re-roll on collision).
	 */
	nextAgentId(): string {
		const name = randomAgentName(this.usedNames);
		this.usedNames.add(name);
		return name;
	}

	/** Track a background agent: registry entry + widget row. */
	register(agent: RegisteredAgent, status: "running" | "idle" = "running"): void {
		this.agents.set(agent.agentId, agent);
		this.getWidget()?.add(agent, status);
	}

	lookup(agentId: string): RegisteredAgent | undefined {
		return this.agents.get(agentId);
	}

	/**
	 * Completion policy + cleanup, single choke point. Notifies unless the
	 * stop was user-controlled; always removes the bookkeeping and stops the
	 * child (idempotent — safe for never-registered spawn failures and for
	 * completions arriving after stopAndRemove). A persistent agent that
	 * completed stays registered (idle, process resident) — agent_stop
	 * removes it later.
	 */
	async complete(agent: RegisteredAgent, completion: AgentCompletion): Promise<void> {
		const notify = () => (agent.stoppedByControl ? Promise.resolve() : this.notify(agent, completion));
		if (agent.persistent && completion.status === "completed") {
			try {
				// A failed notification must never kill a resident agent — the
				// idle row stays (addressable), the agent stays up.
				await Promise.resolve(notify()).catch(() => {});
			} finally {
				// Resident — no remove, no stop. The widget row flips to idle so
				// the agent stays addressable (agent_stop removes it later).
				this.getWidget()?.setStatus?.(agent.agentId, "idle");
			}
			return;
		}
		try {
			await notify();
		} finally {
			this.remove(agent.agentId, completion.status === "completed" ? "done" : completion.status);
			await agent.stop().catch(() => {});
		}
	}

	/**
	 * Route one message against my direct children (pure; the caller — the
	 * agent_send execute or the inbound handler — acts on the decision:
	 * deliver to a child / inject the parent LLM / error).
	 */
	route(msg: AgentMessage): RouteDecision {
		return routeMessage(msg, [...this.agents.keys()], this.hasParent);
	}

	/** Point-to-point delivery to a direct child by exact id. */
	async deliver(target: string, text: string): Promise<boolean> {
		const agent = this.agents.get(target);
		if (!agent?.sendMessage) return false;
		const ok = await agent.sendMessage(text);
		// A delivered message woke an idle persistent agent — the widget row
		// flips back to running (spinner resumes). Harmless for running rows.
		if (ok) this.getWidget()?.setStatus?.(target, "running");
		return ok;
	}

	/** Flip a persistent agent's widget row back to idle (wake finished). */
	markIdle(agentId: string): void {
		this.getWidget()?.setStatus?.(agentId, "idle");
	}

	/** agent_stop path: graceful stop + removal (no notification).
	 *  Returns whether an agent was actually stopped (false when it finished
	 *  between lookup and removal). A rejecting stop() propagates — the
	 *  caller (agent_stop.execute) surfaces it as a tool error, matching
	 *  the original wiring. */
	async stopAndRemove(agentId: string): Promise<boolean> {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		await agent.stop();
		this.remove(agentId, "stopped");
		return true;
	}

	/** Stop everything (session shutdown). */
	async shutdown(): Promise<void> {
		for (const agent of this.agents.values()) {
			void agent.stop();
		}
		this.agents.clear();
		this.getWidget()?.dispose();
	}

	private remove(agentId: string, result?: WidgetResult): void {
		// Only touch the widget for agents we actually tracked — a spawn-
		// failure completion never registered, so delete() returns false and
		// the widget stays untouched (no spurious requestRender).
		if (this.agents.delete(agentId)) this.getWidget()?.remove(agentId, result);
	}
}
