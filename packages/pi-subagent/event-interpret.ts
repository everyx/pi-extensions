/**
 * pi-subagent — event interpretation (raw RpcEvent → AgentEvent).
 *
 * The only place pi's rpc protocol vocabulary is mapped onto our domain
 * vocabulary. protocol.ts only classifies lines as response vs event; this
 * module gives events *meaning*: settle notifications, streamed text deltas,
 * thinking/tool-call activity, and model API errors.
 *
 * Since pi v0.84.0 the rpc `message_update` event carries only
 * `assistantMessageEvent` deltas — the cumulative `message` snapshot and the
 * `partial` field were removed (quadratic-output fix). So activity is derived
 * from deltas: `thinking_delta` marks reasoning, `toolcall_end` is the
 * authoritative tool-call (the wire streams the name on `toolcall_start` and
 * arguments on `toolcall_delta`, but only the end event carries the complete
 * call — the earlier events are deliberately ignored), and text arrives as
 * `text_delta`.
 *
 * Pure and side-effect free — unit-tested against raw event shapes as they
 * arrive off the wire. AgentProcess.onEvent is a thin switch over the result.
 */

import type { WidgetResult } from "@everyx/pi-ui/widget.js";
import type { AgentMessage, RpcEvent } from "./protocol.js";

/**
 * One unit of sub-agent activity — thinking, streamed text, or a tool call.
 * Produced here (the semantic layer), consumed by AgentProcess as the event
 * fold and the widget excerpt; consumers decide how to display it (the card
 * body rows in views.ts assemble the "name: args" label).
 */
export type AgentActivity =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; args: string; id?: string };

/** Closed union of interpreted events — the domain vocabulary. */
export type AgentEvent =
	| { type: "settled" }
	| { type: "thinking" }
	| { type: "tool_call"; activity: Extract<AgentActivity, { kind: "tool" }> }
	| { type: "text_delta"; delta: string }
	| { type: "agent_failed"; error: string }
	| { type: "agent_msg"; message: AgentMessage }
	| { type: "agent_tree"; event: AgentTreeEvent };

/** Status key that carries agent_send messages over extension_ui_request. */
export const MSG_STATUS_KEY = "pi-subagent-msg";

/** Status key that carries tree telemetry over extension_ui_request. */
export const TREE_STATUS_KEY = "pi-subagent-tree";

/**
 * Tree telemetry — one hop of the spawn tree reporting a nested agent's state
 * upward. Emitted by a node for its own children — ALL spawns, foreground and
 * background alike (depth starts at 1); every intermediate node forwards
 * verbatim with depth + 1. Consumption is decided at the anchor boundary: the
 * root applies background-child events to the widget and folds foreground-
 * child events into that card's nested meta counters — one subtree, one
 * surface. Ids are globally unique (name-gen), so activity/remove need no
 * depth.
 *
 * Orphan note: if the reporting node dies before its child finishes, the
 * child's remove still arrives eventually — the parent's deadline-bounded
 * waitForCompletion rejects and emits a best-effort "stopped". The row never
 * hangs forever; it may just outlive the truth by up to one deadline.
 */
export type AgentTreeEvent =
	| { op: "add"; id: string; label: string; startedAt: number; depth: number; status: "running" | "idle" }
	| { op: "activity"; id: string; activity: AgentActivity }
	| { op: "remove"; id: string; status: WidgetResult };

/**
 * Summarize tool-call arguments into a one-line excerpt: the friendly arg
 * key when the tool has one (bash→command, read/write/edit→path,
 * grep/find→pattern), otherwise the JSON with a truncated tail.
 */
function summarizeArgs(name: string, args: unknown): string {
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		const key =
			name === "bash"
				? "command"
				: name === "read" || name === "write" || name === "edit"
					? "path"
					: name === "grep" || name === "find"
						? "pattern"
						: undefined;
		if (key && typeof a[key] === "string" && a[key]) return a[key];
		const json = JSON.stringify(a);
		if (json.length > 80) {
			// Code-point-safe truncation — slicing a UTF-16 string at 80 could
			// split a surrogate pair (emoji) and emit U+FFFD garbage.
			return `${Array.from(json).slice(0, 80).join("")}\u2026`;
		}
		return json;
	}
	return "";
}

/**
 * Interpret one raw RpcEvent. A single message_update carries exactly one
 * assistantMessageEvent delta, so the result is a list (empty when nothing
 * maps). Events the extension doesn't care about map to nothing, like pi's
 * own jsonl layer ignores unknown records.
 */
export function interpretEvent(raw: RpcEvent): AgentEvent[] {
	if (raw.type === "agent_settled") return [{ type: "settled" }];

	if (raw.type === "message_update") {
		const ae = raw.assistantMessageEvent as
			| { type?: string; delta?: unknown; toolCall?: { name?: unknown; arguments?: unknown; id?: unknown } }
			| undefined;
		if (ae?.type === "text_delta" && typeof ae.delta === "string") {
			return [{ type: "text_delta", delta: ae.delta }];
		}
		if (ae?.type === "thinking_delta") {
			return [{ type: "thinking" }];
		}
		if (ae?.type === "toolcall_end" && typeof ae.toolCall?.name === "string") {
			const activity: Extract<AgentActivity, { kind: "tool" }> = {
				kind: "tool",
				name: ae.toolCall.name,
				args: summarizeArgs(ae.toolCall.name, ae.toolCall.arguments),
			};
			if (typeof ae.toolCall.id === "string") activity.id = ae.toolCall.id;
			return [{ type: "tool_call", activity }];
		}
		return [];
	}

	if (raw.type === "extension_ui_request") {
		// In-tree channels: the sender's extension emits a setStatus carrying a
		// JSON payload under one of our reserved keys (rpc-mode forwards
		// extension_ui_request verbatim, no throttling). Anything else in the
		// extension_ui_request namespace is not ours — ignore.
		if (typeof raw.statusText !== "string") return [];
		if (raw.method === "setStatus" && raw.statusKey === MSG_STATUS_KEY) {
			try {
				const parsed = JSON.parse(raw.statusText) as { to?: unknown; from?: unknown; message?: unknown };
				if (typeof parsed.to === "string" && typeof parsed.message === "string") {
					return [
						{
							type: "agent_msg" as const,
							message: {
								to: parsed.to,
								from: typeof parsed.from === "string" ? parsed.from : "",
								message: parsed.message,
							},
						},
					];
				}
			} catch {
				/* malformed payload — ignore */
			}
			return [];
		}
		// Tree telemetry: same transport, own reserved key, validated per-op.
		if (raw.method === "setStatus" && raw.statusKey === TREE_STATUS_KEY) {
			try {
				return [{ type: "agent_tree" as const, event: parseTreeEvent(JSON.parse(raw.statusText)) }].filter(
					(e) => e.event !== undefined,
				) as [{ type: "agent_tree"; event: AgentTreeEvent }];
			} catch {
				return []; // malformed payload — ignore
			}
		}
		return [];
	}

	if (raw.type === "agent_end") {
		// pi marks an agent_end with `willRetry: true` when it will transparently
		// retry the turn (e.g. transient API errors). That first error is not a
		// failure — the final agent_end decides. Without this gate the stale
		// error would land in agentError, which has no reset path, and a
		// retried-and-successful sub-agent would report failed.
		if (raw.willRetry === true) return [];
		const messages = raw.messages as Array<{ role?: string; stopReason?: string; errorMessage?: unknown }> | undefined;
		if (Array.isArray(messages)) {
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (m?.role === "assistant" && m.stopReason === "error") {
					return [
						{
							type: "agent_failed",
							error: typeof m.errorMessage === "string" && m.errorMessage ? m.errorMessage : "Agent model API error",
						},
					];
				}
			}
		}
		return [];
	}

	return [];
}

/** Validate an untrusted tree-event payload, op by op. Undefined = malformed. */
function parseTreeEvent(value: unknown): AgentTreeEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || !v.id) return undefined;
	switch (v.op) {
		case "add":
			if (typeof v.label !== "string" || typeof v.startedAt !== "number" || typeof v.depth !== "number") {
				return undefined;
			}
			if (v.status !== "running" && v.status !== "idle") return undefined;
			return { op: "add", id: v.id, label: v.label, startedAt: v.startedAt, depth: v.depth, status: v.status };
		case "activity":
			return isActivity(v.activity) ? { op: "activity", id: v.id, activity: v.activity } : undefined;
		case "remove":
			if (v.status !== "done" && v.status !== "failed" && v.status !== "stopped") return undefined;
			return { op: "remove", id: v.id, status: v.status as WidgetResult };
		default:
			return undefined;
	}
}

function isActivity(value: unknown): value is AgentActivity {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.kind === "thinking" || v.kind === "text") return typeof v.text === "string";
	if (v.kind === "tool") return typeof v.name === "string" && typeof v.args === "string";
	return false;
}
