/**
 * pi-subagent — shared protocol types.
 *
 * These are the domain types that flow between the agent lifecycle
 * (agent-process.ts → index.ts) and the TUI rendering (render.ts). They
 * live here rather than in either module so tool-output shapes have a
 * single source of truth — the tool definition site (index.ts) and the
 * render site (render.ts) both import from here.
 */

import type { AgentActivity } from "./agent-process.js";

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

/** LLM-context truncation info (aligns with bash tool truncateTail). */
export interface Truncation {
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	outputLines: number;
	totalLines: number;
	maxLines: number;
	maxBytes: number;
}

/**
 * Tool-output details for the Agent tool (carried in pi's `details` field).
 * renderAgentCall / renderAgentResult read from here; index.ts populates
 * it in the execute callback.
 */
export interface SubagentDetails {
	task?: string;
	agentId?: string;
	/** Agent title — used by the background-start status line (the tool header is empty for background). */
	title?: string;
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
	/** LLM-context truncation info — the card warns when set; intact data in the session file. */
	truncation?: Truncation;
}

/**
 * Notification-delivery details (rendering side). Populated by
 * notifyCompletion() in index.ts, consUmed by renderNotification().
 * The LLM sees only the JSON `content` block; `details` never enter
 * context (verified against pi's convertToLlm).
 */
export interface NotificationDetails {
	status: string;
	agent_id: string;
	/** Required — always passed by notifyCompletion (AgentProcess.title). */
	title: string;
	/** Resolved model string, or default when omitted. */
	model?: string;
	/** Reasoning intensity, or inherited level when omitted. */
	thinking?: string;
	/** Final output — rendered as the card body (never enters LLM context). */
	result?: string;
	usage?: {
		tokens?: number | null;
		toolUses?: number | null;
		durationMs?: number | null;
	};
	sessionPath?: string;
	sessionId?: string;
	truncation?: Truncation;
}
