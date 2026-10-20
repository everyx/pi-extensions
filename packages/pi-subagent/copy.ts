/**
 * pi-subagent — every string the model reads.
 *
 * One file, because these strings are one interface: the model pays for all of
 * them on every request, and a change to one usually means a change to a
 * neighbour. Keeping them here makes the diff reviewable as a whole and makes
 * the budget test (test/llm-copy.test.ts) possible at all.
 *
 * Where a line belongs is decided by when it is first needed, not by which
 * tool it belongs to (see repo AGENTS.md, "LLM 文案"):
 *
 *   L0 selection  snippet     — when to reach for the tool            ≤10 words
 *   L1 contract   description — what the call does, how to fill it
 *   L2 behaviour  guidelines  — what is still easy to get wrong after
 *                               reading L0/L1 and seeing one real result
 *   L3 fact       tool result — what just happened (not modelled here)
 *   L4 detail     details     — full text, usage, session path (no context)
 *
 * Three batching rules, in order of how much they save:
 *   1. one fact lives in one layer (a duplicate drifts),
 *   2. a layer never restates the layer below it (that repetition is the
 *      bulk of the waste),
 *   3. entries that share a trigger merge into one.
 */

export interface ToolCopy {
	/** L1 — the contract. Says what the call does and what comes back when
	 *  that timing is not obvious from the name; never a field list (the
	 *  first real result demonstrates the shape). */
	description: string;
	/** L0 — the one line in the system prompt's tool list. A tool without a
	 *  snippet is not listed at all, so this is required, not optional. */
	snippet: string;
	/** L2 — behaviour that survives L0, L1 and one real result. */
	guidelines: string[];
	/** L1 — descriptions worth their tokens: format, units, semantics, and
	 *  defaults that change behaviour. A parameter whose name says it all
	 *  has no entry. */
	paramDescriptions: Record<string, string>;
}

export const TOOL_COPY = {
	agent_spawn: {
		description:
			"Spawn an isolated sub-agent with its own context. Returns an agent id immediately; " +
			"the result arrives as a completion notification.",
		snippet: "Spawn an isolated sub-agent for heavy, parallel, or context-heavy work",
		guidelines: [
			"Write agent_spawn prompts self-contained — the sub-agent has zero context: include paths, constraints, and the expected output shape.",
			"For independent work, issue several agent_spawn calls together; they run concurrently.",
			"Wait for the completion notification when your answer depends on the result. To continue an agent whose session ended, spawn again with `resume` set to the path that notification reported.",
			"Long outputs are truncated for your context; the result then carries the full-output file path.",
		],
		paramDescriptions: {
			model:
				"Model for the sub-agent — provider/modelId or fuzzy name. " +
				"Omit to inherit yours; only switch when the task needs a different model.",
			thinking:
				'Reasoning intensity ("off"…"max"). ' +
				"Omit to inherit yours; only change it when the task needs a different depth.",
			tools: "Tool allowlist. Omit to grant all; for read-only exploration restrict to read/grep/find/ls.",
			timeoutMs:
				"Optional wall-clock deadline for the whole task, in ms. Omit for no limit. " +
				"On expiry the agent is stopped and the notification reports stopped.",
			resume:
				"Session file to continue — the path a previous completion notification reported. " +
				"The prompt runs on top of that history.",
			persistent:
				"Keep the agent resident (idle, zero token) after it completes so you can send " +
				"follow-ups. Default false (it exits when done).",
		},
	},
	agent_stop: {
		description:
			"Terminate a sub-agent: a running one discards its work, a persistent idle one exits. " +
			"Deliberate stops are not notified.",
		snippet: "Stop a running or idle sub-agent",
		guidelines: ["Stop a persistent agent when you no longer need it — it holds a resident process until stopped."],
		paramDescriptions: {
			agent_id: 'The agent id to stop (e.g. "@max").',
		},
	},
	agent_send: {
		description: "Send a message to another agent — a sub-agent or your parent.",
		snippet: "Send a message to a sub-agent or your parent",
		guidelines: [
			"Send follow-up instructions to a persistent agent with agent_send — its context is intact and it wakes to handle the message.",
			"A sub-agent blocked on missing information should agent_send @parent a concise question; the parent replies the same way.",
		],
		paramDescriptions: {
			to:
				'The agent id from agent_spawn (e.g. "@max" — a spawn result or completion ' +
				'notification carries it), or "@parent" to message the session that spawned you.',
		},
	},
} as const satisfies Record<string, ToolCopy>;

export type ToolName = keyof typeof TOOL_COPY;
