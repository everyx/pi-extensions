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

export interface RpcCommandPrompt {
	id: string;
	type: "prompt";
	message: string;
}

export interface RpcCommandSteer {
	id: string;
	type: "steer";
	message: string;
}

export interface RpcCommandAbort {
	id: string;
	type: "abort";
}

export interface RpcCommandGetLastAssistantText {
	id: string;
	type: "get_last_assistant_text";
}

export interface RpcCommandGetState {
	id: string;
	type: "get_state";
}

export interface RpcCommandGetSessionStats {
	id: string;
	type: "get_session_stats";
}

export interface RpcCommandGetEntries {
	id: string;
	type: "get_entries";
}

export type RpcCommand =
	| RpcCommandPrompt
	| RpcCommandSteer
	| RpcCommandAbort
	| RpcCommandGetLastAssistantText
	| RpcCommandGetState
	| RpcCommandGetSessionStats
	| RpcCommandGetEntries;

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
		if (typeof obj.command !== "string") return null;
		return { kind: "response", response: value as RpcResponse };
	}

	if (typeof obj.type === "string") {
		return { kind: "event", event: value as RpcEvent };
	}

	return null;
}
