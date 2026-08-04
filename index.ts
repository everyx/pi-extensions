/**
 * pi-subagent — spawn isolated sub‑agent pi instances.
 *
 * Architecture (issue #10):
 *   index.ts          — tool registration (Agent / AgentControl) + schemas + notification delivery
 *   protocol.ts       — pure JSONL protocol layer (tested)
 *   rpc-client.ts     — stateful thin JSONL client (spawn + transport)
 *   event-interpret.ts— raw RpcEvent → AgentEvent adapter (pure, tested)
 *   agent-process.ts  — AgentProcess: one resident `pi --mode rpc` child, semantic API
 *   registry.ts       — AgentRegistry: running-agent lifecycle + completion policy (tested)
 *   model.ts          — model-spec → ResolvedModel (testable)
 *   render.ts         — TUI rendering + notification card renderer
 *   widget.ts         — Agents status widget
 *
 * Every sub‑agent is a resident `pi --mode rpc` child with a persisted
 * session. Foreground Agent calls block until completion; background calls
 * return an agent_id immediately and deliver a completion notification
 * (`customType: "subagent-notification"`, deliverAs "followUp") carrying the
 * final output. AgentControl steers or stops a running background agent.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentActivity, type AgentCompletion, AgentProcess } from "./agent-process.js";
import { resolveModel } from "./model.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import {
	type AgentControlParams,
	type AgentParams,
	renderAgentCall,
	renderAgentControlCall,
	renderAgentControlResult,
	renderAgentResult,
	renderNotification,
} from "./render.js";
import type { NotificationDetails } from "./types.js";
import { AgentWidget } from "./widget.js";

// ─── Running background agents registry ─────────────────────

/** Expand a leading `~` (pi's own expandTildePath only normalizes). */
function expandTilde(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Agent sessions directory: `<agentDir>/subagent-sessions` by default
 * (agentDir honors PI_CODING_AGENT_DIR like pi itself), overridable via
 * PI_SUBAGENT_SESSION_DIR. Kept outside pi's standard session tree so
 * `pi -r` stays clean; resume goes through the main session via the
 * session path on the notification / tool result.
 */
function resolveSubagentSessionDir(): string {
	const override = process.env.PI_SUBAGENT_SESSION_DIR;
	if (override) return expandTilde(override);
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(expandTilde(agentDir), "subagent-sessions");
}

const SUBAGENT_SESSION_DIR = resolveSubagentSessionDir();

/** TUI-only background-agent status widget (created lazily, tui mode only). */
let widget: AgentWidget | null = null;

function ensureWidget(ctx: { mode: string; ui: unknown }): AgentWidget | null {
	if (widget) return widget;
	if (ctx.mode !== "tui") return null;
	// biome-ignore lint/suspicious/noExplicitAny: ExtensionUIContext shape from pi
	widget = new AgentWidget(ctx.ui as any);
	return widget;
}

/** Narrow TUI adapter: AgentWidget → WidgetSurface (registry seam). */
function widgetSurface(): WidgetSurface | null {
	const w = widget;
	if (!w) return null;
	return {
		add: (agent) => w.add(agent as AgentProcess),
		remove: (agentId) => w.remove(agentId),
		dispose: () => w.dispose(),
	};
}

// ─── Tool parameter schemas ──────────────────────────────────

const AgentParamsSchema = Type.Object({
	prompt: Type.String({
		description:
			"The task for the sub-agent. Must be self-contained — the sub-agent starts with " +
			"zero context from this conversation. Include file paths, constraints, and the " +
			"desired output shape.",
	}),
	title: Type.String({
		description:
			"Short task title (3-5 words) — required. Identifies the agent in the UI, " +
			"notification card, and session name.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Model for the sub-agent — provider/modelId or fuzzy name (e.g. "haiku", "sonnet"). ' +
				"Omit to inherit your current model.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
			description:
				'Reasoning intensity for the sub-agent ("off"…"max"). ' + "Omit to inherit your current thinking level.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Tool allowlist for the sub-agent. Omit to grant all tools. For read-only " +
				"exploration, restrict to read/grep/find/ls and consider a cheaper model.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"If true, return an agent_id immediately and notify you on completion — you can " +
				"keep working meanwhile. If false (default), block until the result is ready.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Optional wall-clock deadline for the whole task, in milliseconds. Omit for no " +
				"time limit (the default — the child runs until it finishes or is stopped). " +
				"Pass a value when you want to bound a risky/looping task; on expiry the agent is " +
				"stopped and the call reports stopped.",
		}),
	),
});

const AgentControlParamsSchema = Type.Object({
	agent_id: Type.String({ description: "The agent ID to control." }),
	action: StringEnum(["steer", "stop"], {
		description: '"steer" — inject a redirecting message into a running agent. "stop" — terminate it.',
	}),
	message: Type.Optional(
		Type.String({
			description:
				'Required when action is "steer". The message injected as a user message into ' + "the agent's conversation.",
		}),
	),
});

// ─── Helpers ─────────────────────────────────────────────────

/**
 * LLM-context protection for result content, aligned with pi's bash tool:
 * truncateTail keeps the tail (2000 lines / 50KB). Only LLM-visible content
 * is capped — details.events stay complete, so folding/expansion never
 * loses content for the user; the session file has everything. Single exit
 * for every path that produces LLM-visible output (foreground result,
 * background notification).
 */
export function truncateForContext(text: string): string {
	return truncateTail(text).content;
}

function toErrorResult(err: unknown): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
		isError: true,
	};
}

/** Spawn-failure tool result: isError + the reason (LLM + user card share it). */
function spawnErrorResult(
	started: { error: string },
	extra: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	return {
		content: [{ type: "text", text: started.error }],
		details: { error: started.error, ...extra },
		isError: true as const,
	};
}

/** Deliver a completion notification: JSON content (LLM) + rich details (user card). */
function notifyCompletion(pi: ExtensionAPI, agent: RegisteredAgent, completion: AgentCompletion): void {
	const details: NotificationDetails = {
		status: completion.status,
		agent_id: agent.agentId,
		title: agent.title,
		model: agent.model,
		thinking: agent.thinking,
		// Card body (never enters LLM context — verified against convertToLlm).
		// The full output; the LLM-visible content below is capped (truncateTail).
		result: completion.output,
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
				agent_id: agent.agentId,
				// LLM-context protection: cap the visible result (tail 2000 lines /
				// 50KB, bash parity) — the full text lives in details.result (card
				// body, never enters LLM context) and the session file.
				result: truncateForContext(completion.output),
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

// ─── Default export (pi extension entry) ───────────────────────

export default function (pi: ExtensionAPI) {
	// pi's agent-core drops the execute() isError flag when a tool returns
	// normally (bash gets its error background by throwing instead) — see
	// agent-core executePreparedToolCall. Re-attach it for our tools by
	// marking every error path in `details.error`; the handler restores
	// isError so failed Agent/AgentControl calls render with toolErrorBg
	// like bash, while keeping the details (status line) intact.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "Agent" && event.toolName !== "AgentControl") return undefined;
		const details = event.details as { error?: unknown } | undefined;
		if (!details || details.error === undefined) return undefined;
		return { isError: true };
	});

	// One registry per session: owns the running-agent bookkeeping and the
	// completion policy (notify unless user-stopped; cleanup on every path).
	const registry = new AgentRegistry({
		notify: (agent, completion) => notifyCompletion(pi, agent, completion),
		getWidget: () => widgetSurface(),
	});
	// ── Agent ───────────────────────────────────────────
	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description:
			"Spawn a sub-agent that works in its own isolated context window. " +
			"The sub-agent starts with zero context from this conversation, so the prompt " +
			"must be self-contained: include file paths, constraints, and the desired output shape. " +
			"Use it for heavy tasks whose verbose intermediate output (search results, logs, test " +
			"output) would pollute your context, and for independent tasks that can run in parallel. " +
			"Foreground (run_in_background: false): blocks until the sub-agent finishes and returns " +
			"its final output directly. Background (run_in_background: true): returns an agent_id " +
			"immediately; the completion notification carries its result (status + agent_id + final " +
			"output), and you can intervene with AgentControl while it runs.",
		promptSnippet: "Spawn an isolated sub-agent for heavy, parallel, or context-heavy work",
		promptGuidelines: [
			"Use Agent when a task would flood your context with verbose intermediate output — the sub-agent keeps it in its own window and returns only its final output.",
			"Use Agent for independent parallel work: spawn several with run_in_background: true — each completion notification carries its own result.",
			"Write Agent prompts self-contained: the sub-agent has zero context from this conversation. Include paths, constraints, and the expected output shape.",
			"Never poll a background Agent. Wait for its completion notification — it carries the result directly.",
			"Trust but verify: a sub-agent's summary describes intent, not outcome. Check its actual changes before reporting work as done.",
		],
		parameters: AgentParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			const params = raw as AgentParams;
			const task = params.prompt?.trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "`prompt` is required." }],
					details: { error: "`prompt` is required." },
					isError: true,
				};
			}

			const resolved = resolveModel(ctx.modelRegistry, ctx.model, params.model);
			if (resolved.error) {
				// Background: render as the status line `Agent <title> start failed:
				// <reason>` (the id never exists yet — spawn didn't happen).
				return {
					content: [{ type: "text", text: resolved.error }],
					details: params.run_in_background
						? { runInBackground: true, title: params.title, error: resolved.error }
						: { error: resolved.error },
					isError: true,
				};
			}

			const startedAt = Date.now();

			// Foreground: stream the sub-agent's session as an ordered activity
			// stream. AgentProcess accumulates RenderEvents internally at the
			// source (RPC event handler); the callbacks here only refresh the
			// live card via onUpdate.
			let streamed = "";
			// Live-card details: the shared slice every foreground update carries.
			const liveDetails = (activity?: AgentActivity) => ({
				task,
				startedAt,
				model: agent.model,
				thinking: agent.thinking,
				activity,
				events: agent.getEvents(),
			});
			const agent = new AgentProcess({
				agentId: registry.nextAgentId(),
				cwd: ctx.cwd,
				model: resolved.model,
				thinking: params.thinking ?? pi.getThinkingLevel(),
				tools: params.tools,
				title: params.title,
				sessionDir: SUBAGENT_SESSION_DIR,
				timeoutMs: params.timeoutMs,
				onDelta: (delta) => {
					if (params.run_in_background) return;
					streamed += delta;
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: liveDetails(agent.getLatestActivity() ?? undefined),
					});
				},
				onActivityChange: (activity) => {
					if (params.run_in_background) return;
					if (activity.kind === "text") return; // covered by onDelta
					onUpdate?.({ content: [{ type: "text", text: streamed }], details: liveDetails(activity) });
				},
			});

			// Wire the execute AbortSignal (user cancel) to a graceful stop.
			// Guarded: only stop while the agent is still live — a late abort
			// (signal outliving this execute) must not stop an agent that
			// already reached a terminal state or flip stoppedByControl.
			const onAbort = () => {
				if (agent.status === "queued" || agent.status === "running") void agent.stop();
			};
			if (signal?.aborted) {
				onAbort();
			} else {
				signal?.addEventListener("abort", onAbort, { once: true });
			}

			try {
				// Background: show the starting spinner line while the child spawns.
				// (Foreground keeps the tool header `Agent <title> (model)`.)
				if (params.run_in_background) {
					onUpdate?.({
						content: [{ type: "text", text: `Starting ${agent.title}\u2026` }],
						details: { runInBackground: true, title: agent.title, model: agent.model, thinking: agent.thinking },
					});
				}

				const started = await agent.spawnAndSend(task);

				// ── Background: return agent_id now, notify on completion ──
				if (params.run_in_background) {
					// Spawn failure: the isError return already carries the failure
					// to the LLM and the status line shows it to the user — a
					// followUp notification would deliver the same failure twice.
					if (!started.ok) {
						signal?.removeEventListener("abort", onAbort);
						await agent.stop().catch(() => {});
						return spawnErrorResult(started, { runInBackground: true, title: agent.title });
					}

					// Abort is wired to stop while spawning only; once the spawn
					// settled, the background agent runs on its own — the user
					// controls it via AgentControl, and this (already returned)
					// tool call's signal must not kill it later.
					signal?.removeEventListener("abort", onAbort);
					ensureWidget(ctx); // widget row added via the registry (non-TUI: no-op)
					registry.register(agent);
					void agent
						.waitForCompletion()
						.then((completion) => registry.complete(agent, completion))
						// Defensive: waitForCompletion is deadline-bounded and never
						// rejects today — if it ever does, clean up without notifying.
						.catch(() => registry.stopAndRemove(agent.agentId));

					onUpdate?.({
						content: [{ type: "text", text: `Started ${agent.title} (background)` }],
						details: {
							runInBackground: true,
							title: agent.title,
							model: agent.model,
							thinking: agent.thinking,
							startedAt,
						},
					});
					return {
						content: [
							{
								type: "text",
								text: `Started background agent ${agent.agentId}. Completion arrives as a notification.`,
							},
						],
						details: {
							runInBackground: true,
							title: agent.title,
							model: agent.model,
							thinking: agent.thinking,
							startedAt,
						},
					};
				}

				// ── Foreground: block until completion ──
				if (!started.ok) {
					await agent.stop().catch(() => {});
					signal?.removeEventListener("abort", onAbort);
					return spawnErrorResult(started);
				}

				onUpdate?.({
					content: [{ type: "text", text: "Working\u2026" }],
					details: { task, startedAt, model: agent.model, thinking: agent.thinking },
				});

				const completion = await agent.waitForCompletion();
				await agent.stop().catch(() => {});
				signal?.removeEventListener("abort", onAbort);

				// Failures and limit-stops are both errors for the caller: the
				// stopped case (total timeout / hard token limit) must not look
				// like a clean success — mark details.error so the isError
				// workaround hook restores the error background. A stopped agent
				// is also what a user cancel (abort) produces — don't blame that
				// on the limits.
				if (completion.status === "failed" || completion.status === "stopped") {
					const message =
						completion.status === "failed"
							? completion.output || "Sub-agent failed."
							: agent.stoppedByControl
								? completion.output || "Sub-agent stopped."
								: `${completion.output || "Sub-agent was stopped."}\n(stopped \u2014 reached the task time/token limit; the output above is partial)`;
					return {
						content: [{ type: "text", text: truncateForContext(message) }],
						details: {
							task,
							startedAt,
							endedAt: Date.now(),
							// Full message (uncapped) — the user reads it on the card,
							// folded but never dropped; the LLM sees the capped copy.
							error: message,
							model: agent.model,
							thinking: agent.thinking,
							sessionPath: completion.sessionPath,
							events: agent.getEvents(),
						},
						isError: true,
					};
				}
				return {
					// Pure text result — no session hint: the output stands alone
					// (the session path is the card footer, recoverable by the user).
					content: [{ type: "text", text: truncateForContext(completion.output) }],
					details: {
						task,
						sessionPath: completion.sessionPath,
						sessionId: completion.sessionId,
						startedAt,
						endedAt: Date.now(),
						model: agent.model,
						thinking: agent.thinking,
						events: agent.getEvents(),
					},
				};
			} catch (err) {
				signal?.removeEventListener("abort", onAbort);
				await agent.stop().catch(() => {});
				return toErrorResult(err);
			}
		},

		renderCall: renderAgentCall,
		renderResult: renderAgentResult,
	});

	// ── AgentControl ────────────────────────────────────
	pi.registerTool({
		name: "AgentControl",
		label: "Control Agent",
		description:
			"Intervene in a running sub-agent. steer: inject a message into its conversation to " +
			"redirect its work mid-run (delivered after its current turn settles — only supported " +
			"for background agents still running, before the completion notification is sent). " +
			"stop: terminate a running sub-agent immediately, discarding further work. Only works " +
			"on agents that are currently running.",
		promptSnippet: "Steer or stop a running sub-agent",
		promptGuidelines: [
			'Use AgentControl with action "stop" when a background agent is consuming tokens on a wrong path — stop it and respawn with a corrected prompt.',
		],
		parameters: AgentControlParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate) {
			const params = raw as AgentControlParams;
			// The registry stores full AgentProcess objects — the narrow
			// RegisteredAgent surface is the seam; steer needs the whole child.
			const agent = registry.lookup(params.agent_id) as AgentProcess | undefined;

			if (!agent) {
				return {
					content: [{ type: "text", text: `Agent ${params.agent_id} not found or already finished.` }],
					details: {
						action: params.action,
						error: `agent ${params.agent_id} not found or already finished`,
					},
					isError: true,
				};
			}

			// Runtime validation (schema union may be downgraded by some providers).
			if (params.action !== "steer" && params.action !== "stop") {
				return {
					content: [{ type: "text", text: 'action must be "steer" or "stop".' }],
					details: { error: 'action must be "steer" or "stop".' },
					isError: true,
				};
			}

			if (params.action === "stop") {
				// Partial update first — drives the `⠋ Agent <title> stopping…`
				// spinner line while the child is being stopped.
				onUpdate?.({
					content: [{ type: "text", text: `Stopping ${agent.title}\u2026` }],
					details: { action: "stop", title: agent.title },
				});
				try {
					const stopped = await registry.stopAndRemove(params.agent_id);
					if (!stopped) {
						// Finished between lookup and removal (rare) — don't claim
						// a stop that never happened.
						const message = `Agent ${params.agent_id} already finished.`;
						return {
							content: [{ type: "text", text: message }],
							details: {
								agentId: params.agent_id,
								action: "stop",
								title: agent.title,
								error: message,
							},
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: `Stopped agent ${params.agent_id}.` }],
						details: { agentId: params.agent_id, action: "stop", title: agent.title },
					};
				} catch (err) {
					// Child died mid-stop (e.g. write-after-end): surface it as a
					// proper status line, not a bare thrown error.
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: message }],
						details: { agentId: params.agent_id, action: "stop", title: agent.title, error: message },
						isError: true,
					};
				}
			}

			// steer
			const message = params.message?.trim();
			if (!message) {
				return {
					content: [{ type: "text", text: '`message` is required when action is "steer".' }],
					details: {
						action: "steer",
						title: agent.title,
						error: '`message` is required when action is "steer".',
					},
					isError: true,
				};
			}
			if (agent.status !== "running") {
				return {
					content: [
						{
							type: "text",
							text: `Agent ${params.agent_id} is not running (status: ${agent.status}).`,
						},
					],
					details: {
						action: "steer",
						title: agent.title,
						error: `not running (status: ${agent.status})`,
					},
					isError: true,
				};
			}

			let steerError: string | null = null;
			try {
				await agent.steer(message);
			} catch (err) {
				// Child died between lookup and steer (write-after-end): surface
				// it as a status line, not a bare thrown error. Note: a .catch()
				// callback's return value would be swallowed — the tool result
				// must come from an explicit return after the try.
				steerError = err instanceof Error ? err.message : String(err);
			}
			if (steerError) {
				return {
					content: [{ type: "text", text: steerError }],
					details: { action: "steer", title: agent.title, error: steerError },
					isError: true,
				};
			}
			if (agent.status !== "running") {
				// The child settled or died while the steer was in flight — the
				// completion notification (if any) carries the real outcome.
				return {
					content: [{ type: "text", text: `Agent ${params.agent_id} finished before the steer arrived.` }],
					details: {
						action: "steer",
						title: agent.title,
						error: `finished before the steer arrived (status: ${agent.status})`,
					},
					isError: true,
				};
			}
			return {
				// The injected message rides in the tool content so the LLM keeps
				// it across compaction; the user sees it as the quote line on the card.
				content: [{ type: "text", text: `Steered agent ${params.agent_id}: "${message}".` }],
				details: { action: "steer", title: agent.title, message },
			};
		},

		renderCall: renderAgentControlCall,
		renderResult: renderAgentControlResult,
	});

	// ── Notification card (user side) ───────────────────
	pi.registerMessageRenderer("subagent-notification", renderNotification);

	// ── Cleanup on exit ─────────────────────────────────
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;

		// Graceful stop of every tracked agent. Children exit on their own
		// (stdin EOF → rpc shutdown) even if the parent dies first, because
		// the pipe closes — no tmux, no disk cleanup, no signals.
		await registry.shutdown();
	});
}
