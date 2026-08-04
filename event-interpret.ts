/**
 * pi-subagent — event interpretation (raw RpcEvent → AgentEvent).
 *
 * The only place pi's rpc protocol vocabulary is mapped onto our domain
 * vocabulary. protocol.ts only classifies lines as response vs event; this
 * module gives events *meaning*: settle notifications, streamed text deltas,
 * activity transitions (thinking / text / tool call), and model API errors.
 *
 * Pure and side-effect free — unit-tested against raw event shapes as they
 * arrive off the wire. AgentProcess.onEvent is a thin switch over the result.
 */

import type { AgentActivity } from "./agent-process.js";
import type { RpcEvent } from "./protocol.js";

/** Closed union of interpreted events — the domain vocabulary. */
export type AgentEvent =
	| { type: "settled" }
	| { type: "activity"; activity: AgentActivity }
	| { type: "text_delta"; delta: string }
	| { type: "agent_failed"; error: string };

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
 * Interpret one raw RpcEvent. A single message_update can carry both a
 * content-part activity and a text_delta, so the result is a list (empty
 * when nothing maps). Events the extension doesn't care about map to
 * nothing, like pi's own jsonl layer ignores unknown records.
 */
export function interpretEvent(raw: RpcEvent): AgentEvent[] {
	if (raw.type === "agent_settled") return [{ type: "settled" }];

	if (raw.type === "message_update") {
		const events: AgentEvent[] = [];

		// Activity from the last content part (thinking / text / toolCall).
		const content = (
			raw.message as
				| {
						content?: Array<{ type?: string; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown }>;
				  }
				| undefined
		)?.content;
		if (Array.isArray(content) && content.length > 0) {
			const last = content[content.length - 1];
			if (last?.type === "thinking" && typeof last.thinking === "string" && last.thinking.trim()) {
				events.push({ type: "activity", activity: { kind: "thinking", text: last.thinking } });
			} else if (last?.type === "text" && typeof last.text === "string" && last.text.trim()) {
				events.push({ type: "activity", activity: { kind: "text", text: last.text } });
			} else if (last?.type === "toolCall" && typeof last.name === "string") {
				events.push({
					type: "activity",
					activity: { kind: "tool", name: last.name, args: summarizeArgs(last.name, last.arguments) },
				});
			}
		}

		// Streamed assistant text.
		const ae = raw.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
		if (ae?.type === "text_delta" && typeof ae.delta === "string") {
			events.push({ type: "text_delta", delta: ae.delta });
		}

		return events;
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
