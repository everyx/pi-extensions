/**
 * pi-subagent — RPC JSONL protocol (pure functions).
 *
 * Framing matches pi's own rpc mode (`dist/modes/rpc/jsonl.js`): one JSON
 * object per line, split on `\n` only — never on U+2028/U+2029.
 *
 * We speak only the subset of the pi rpc protocol this extension needs:
 *   prompt / steer / abort / get_last_assistant_text / get_state / get_session_stats
 *
 * This module is deliberately free of process/stream I/O so it can be unit
 * tested standalone. All stateful wiring lives in rpc-client.ts.
 */

// ─── Commands we send on stdin ──────────────────────────────
//
// Commands carry NO caller-supplied id: RpcClient assigns a unique command
// id per request (correlation key for the pending map / response echo). The
// child (pi rpc-mode) only echoes command.id back — it never routes on it.

export interface RpcCommandPrompt {
	type: "prompt";
	message: string;
	/** When the child is streaming, queue instead of erroring
	 *  ("steer" = delivered after the current turn; "followUp" = after
	 *  everything settles). Omitted → idle starts a new turn, streaming errors. */
	streamingBehavior?: "steer" | "followUp";
}

export interface RpcCommandAbort {
	type: "abort";
}

export interface RpcCommandGetLastAssistantText {
	type: "get_last_assistant_text";
}

export interface RpcCommandGetState {
	type: "get_state";
}

export interface RpcCommandGetSessionStats {
	type: "get_session_stats";
}

export type RpcCommand =
	| RpcCommandPrompt
	| RpcCommandAbort
	| RpcCommandGetLastAssistantText
	| RpcCommandGetState
	| RpcCommandGetSessionStats;

// ─── Responses and events we read from stdout ──────────────

export interface RpcResponseSuccess<T = unknown> {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data?: T;
}

export interface RpcResponseError {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
}

export type RpcResponse = RpcResponseSuccess | RpcResponseError;

/** Session events (agent_settled, agent_end, message_update, …) plus extension_* messages. */
export type RpcEvent = { type: string } & Record<string, unknown>;

export type ParsedLine = { kind: "response"; response: RpcResponse } | { kind: "event"; event: RpcEvent };

// ─── In-tree messaging (agent_send) ────────────────────────

/** One agent_send payload — flows child→parent over the event stream
 * (extension_ui_request) and parent→child as an rpc prompt. */
export interface AgentMessage {
	/** Routing target: "@parent" or a tree-path id ("a2", "a1/a1"). */
	to: string;
	/** Sender's tree-path id ("" for the root session). */
	from: string;
	/** Message text (LLM-visible content). */
	message: string;
}

/** Routing decision for one message at one process. */
export type RouteDecision =
	| { kind: "parent"; message: AgentMessage }
	| { kind: "child"; childId: string; message: AgentMessage }
	| { kind: "uplink"; message: AgentMessage }
	| { kind: "error"; reason: string };

/**
 * Route one message against the local view: my direct children (the only
 * reachable agents) and whether I have a parent. Pure — per-hop O(1),
 * no global registry, no shared state.
 *
 *   "@parent"                → deliver to my parent's LLM (error at root)
 *   my direct child / desc.  → deliver to that child (descendants via its LLM)
 *   anything else            → uplink (my parent may know it); error at root
 */
export function routeMessage(message: AgentMessage, childIds: readonly string[], hasParent: boolean): RouteDecision {
	if (message.to === "@parent") {
		return hasParent ? { kind: "parent", message } : { kind: "error", reason: "root session has no parent" };
	}
	for (const child of childIds) {
		if (message.to === child || message.to.startsWith(`${child}/`)) {
			return { kind: "child", childId: child, message };
		}
	}
	return hasParent ? { kind: "uplink", message } : { kind: "error", reason: `no such agent: ${message.to}` };
}

/** LLM-visible sender prefix: "[from a1] " (root session: ""). */
export function formatFrom(from: string): string {
	return from ? `[from ${from}] ` : "";
}

/** LLM-visible routing hint for cross-generation deliveries (the message
 *  must be forwarded by the receiving agent's LLM): "[to a1/a1] ".
 *  Empty when the message is for the receiving agent itself. */
export function formatTo(to: string, receiver: string): string {
	return to === receiver ? "" : `[to ${to}] `;
}

// ─── Pure helpers ──────────────────────────────────────────

/** Serialize a command to a single JSONL line (LF-terminated). */
export function serializeCommand(command: RpcCommand): string {
	return `${JSON.stringify(command)}\n`;
}

/**
 * Classify a single JSONL line as a response or an event.
 * Returns null for empty lines, unparseable JSON, and malformed records.
 */
export function parseLine(line: string): ParsedLine | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;

	const obj = value as Record<string, unknown>;

	if (obj.type === "response") {
		if (typeof obj.command !== "string" || typeof obj.success !== "boolean") return null;
		return { kind: "response", response: value as RpcResponse };
	}

	if (typeof obj.type === "string") {
		return { kind: "event", event: value as RpcEvent };
	}

	return null;
}
