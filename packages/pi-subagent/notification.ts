/**
 * pi-subagent — completion notification payload construction.
 *
 * One module owns every rule about what a completion notification says and
 * to whom: the LLM-visible JSON (capped, stash-marked), the user-side
 * details card (full output, never enters LLM context), and the context
 * budget helpers shared with foreground results (truncateForContext /
 * maybeWriteFullOutput). render.ts reads the same NotificationDetails —
 * the shape has a single producer, so it cannot drift by hand.
 */

import { type ExtensionAPI, truncateTail } from "@earendil-works/pi-coding-agent";
import { stashOverflow, truncationMarker } from "@everyx/pi-ui/context.js";
import type { AgentCompletion } from "./agent-process.js";
import type { RegisteredAgent } from "./registry.js";
import type { NotificationDetails } from "./types.js";

/**
 * LLM-visible output cap: details.events stay complete, so folding/expansion
 * never loses content for the user; the session file has everything. Single
 * exit for every path that produces LLM-visible output (foreground result,
 * background notification).
 */
export function truncateForContext(text: string): string {
	return truncateTail(text).content;
}

/**
 * When an output exceeds the context cap, stash the full text (shared
 * primitive in pi-ui/context.ts) and return the LLM-visible marker embedded
 * in the result: the model reads the truncated preview and knows the full
 * output is one `read` away. Returns the marker when truncated, "" otherwise.
 */
export function maybeWriteFullOutput(agentId: string, output: string): string {
	const { stashPath } = stashOverflow(output, agentId, { keep: "tail" });
	return stashPath ? truncationMarker(stashPath) : "";
}

/** Deliver a completion notification: LLM JSON as follow-up + user card. */
export function notifyCompletion(pi: ExtensionAPI, agent: RegisteredAgent, completion: AgentCompletion): void {
	const details: NotificationDetails = {
		status: completion.status,
		agent_id: agent.agentId,
		title: `@${agent.agentId} — ${agent.title}`,
		model: agent.model,
		thinking: agent.thinking,
		// Card body (never enters LLM context — verified against convertToLlm).
		// The full output; the LLM-visible content below is capped (truncateTail).
		result: completion.output,
		// Persistent agent completed → resident (idle); a failed follow-up is
		// reported and cleaned up, so the idle marker must not appear there.
		idle: agent.persistent && completion.status === "completed" ? true : undefined,
		usage: {
			tokens: completion.stats.tokens || null,
			toolUses: completion.stats.toolUses || null,
			durationMs: completion.stats.durationMs || null,
		},
		sessionPath: completion.sessionPath,
		sessionId: completion.sessionId,
	};

	pi.sendMessage(
		{
			customType: "subagent-notification",
			content: JSON.stringify({
				status: completion.status,
				agent_id: `@${agent.agentId}`,
				// LLM-context protection: cap the visible result (tail 2000 lines /
				// 50KB, bash parity) — the full text lives in details.result (card
				// body, never enters LLM context) and the session file.
				result: truncateForContext(completion.output) + maybeWriteFullOutput(agent.agentId, completion.output),
				// Only a completed persistent agent stays resident (idle) — a
				// failed follow-up is cleaned up, so no idle claim.
				idle: agent.persistent && completion.status === "completed" ? true : undefined,
				// Resume entry point: sub-agent sessions live outside `pi -r`;
				// attach with `pi --session <path>`.
				session_path: completion.sessionPath ?? null,
			}),
			display: true,
			details,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}
