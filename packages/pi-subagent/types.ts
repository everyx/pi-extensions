/**
 * pi-subagent — shared protocol types.
 *
 * These are the domain types that flow between the agent lifecycle
 * (agent-process.ts → index.ts) and the TUI rendering (render.ts). They
 * live here rather than in either module so tool-output shapes have a
 * single source of truth — the tool definition site (index.ts) and the
 * render site (render.ts) both import from here.
 */

import type { AgentActivity } from "./event-interpret.js";
import type { NestedCounters } from "./nested-fold.js";

/**
 * One step of the sub-agent's session as shown in the card body: a thinking
 * marker, a tool call, or a chunk of streamed text. The body renders these in
 * event order — like replaying the sub-agent's session in pi — instead of a
 * single latest-activity row.
 */
export type RenderEvent =
	| { kind: "thinking" }
	| { kind: "tool"; name: string; args?: string; id?: string }
	| { kind: "text"; text: string };

/**
 * Tool-output details for the Agent tool (carried in pi's `details` field).
 * Populated by index.ts in the tool execute callbacks; consumed by the card
 * views (views.ts) and the notification card (render.ts).
 */
export type SubagentDetails = {
	task?: string;
	agentId?: string;
	/** Agent label — used by the background-start status line (the tool header is empty for background). */
	label?: string;
	/** Resolved "provider/id" model string, or default when omitted. */
	model?: string;
	/** Reasoning intensity ("off"…"max"), or inherited level when omitted. */
	thinking?: string;
	runInBackground?: boolean;
	/** Spawn failure reason — rendered as `start failed: <reason>` on the status line. */
	error?: string;
	sessionPath?: string;
	startedAt?: number;
	endedAt?: number;
	/** Latest activity (thinking/tool) for the widget — widget parity. */
	activity?: AgentActivity;
	/** Ordered activity stream (thinking/tool events) for the card body. */
	events?: RenderEvent[];
	/** Child pi session id (foreground completion — the card footer carries the path). */
	sessionId?: string;
	/** Descendant-spawn counters folded from this child's tree telemetry. */
	nested?: NestedCounters;
};

/**
 * Notification-delivery details (rendering side). Populated by
 * notifyCompletion() in notification.ts, consumed by renderNotification().
 * The LLM sees only the JSON `content` block; `details` never enter
 * context (verified against pi's convertToLlm).
 */
export interface NotificationDetails {
	status: string;
	agent_id: string;
	/** Required — always passed by notifyCompletion (AgentProcess.label). */
	label: string;
	/** Resolved model string, or default when omitted. */
	model?: string;
	/** Reasoning intensity, or inherited level when omitted. */
	thinking?: string;
	/** Final output — rendered as the card body (never enters LLM context). */
	result?: string;
	/** persistent agent: completed but stays resident — the card shows an idle marker. */
	idle?: boolean;
	usage?: {
		tokens?: number | null;
		toolUses?: number | null;
		durationMs?: number | null;
	};
	sessionPath?: string;
	sessionId?: string;
}
