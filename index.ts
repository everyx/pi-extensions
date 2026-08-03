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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentCompletion, AgentProcess } from "./agent-process.js";
import { resolveModel } from "./model.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import {
	type AgentControlParams,
	type AgentParams,
	type NotificationDetails,
	renderAgentCall,
	renderAgentControlCall,
	renderAgentControlResult,
	renderAgentResult,
	renderNotification,
} from "./render.js";
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

function toErrorResult(err: unknown): {
	content: { type: "text"; text: string }[];
	details: Record<string, never>;
	isError: true;
} {
	return {
		content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
		details: {},
		isError: true,
	};
}

/** Deliver a completion notification: JSON content (LLM) + rich details (user card). */
function notifyCompletion(pi: ExtensionAPI, agent: RegisteredAgent, completion: AgentCompletion): void {
	const details: NotificationDetails = {
		status: completion.status,
		agent_id: agent.agentId,
		title: agent.title,
		// Card body (never enters LLM context — verified against convertToLlm).
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
				result: completion.output,
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
				return { content: [{ type: "text", text: "`prompt` is required." }], details: {}, isError: true };
			}

			const resolved = resolveModel(ctx.modelRegistry, ctx.model, params.model);
			if (resolved.error) {
				return { content: [{ type: "text", text: resolved.error }], details: {}, isError: true };
			}

			const startedAt = Date.now();
			// Widget label: the (required) title, truncated defensively.
			const sessionName = params.title.slice(0, 80);

			// Foreground: stream assistant deltas into the tool card (live output).
			let streamed = "";
			const agent = new AgentProcess({
				agentId: registry.nextAgentId(),
				cwd: ctx.cwd,
				model: resolved.model,
				thinking: params.thinking ?? pi.getThinkingLevel(),
				tools: params.tools,
				title: params.title,
				sessionName,
				sessionDir: SUBAGENT_SESSION_DIR,
				onDelta: (delta) => {
					if (params.run_in_background) return; // widget + notification cover background
					streamed += delta;
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: { task, startedAt, activity: agent.getLatestActivity() ?? undefined },
					});
				},
				onActivityChange: (activity) => {
					if (params.run_in_background) return; // widget + notification cover background
					// Thinking/tool transitions refresh the card's activity row even
					// while no text delta is streaming.
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: { task, startedAt, activity },
					});
				},
			});

			// Wire the execute AbortSignal (user cancel) to a graceful stop.
			const onAbort = () => {
				void agent.stop();
			};
			if (signal?.aborted) {
				onAbort();
			} else {
				signal?.addEventListener("abort", onAbort, { once: true });
			}

			try {
				const started = await agent.spawnAndSend(task);

				// ── Background: return agent_id now, notify on completion ──
				if (params.run_in_background) {
					// Spawn failure: deliver the failed notification (D15) — the
					// caller only sees an isError return, the user gets the card.
					if (!started.ok) {
						await registry.complete(agent, {
							status: "failed",
							output: started.error,
							stats: { tokens: 0, toolUses: 0, durationMs: 0 },
							sessionPath: undefined,
							sessionId: undefined,
						});
						return {
							content: [{ type: "text", text: started.error }],
							details: {},
							isError: true,
						};
					}

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
						details: { agentId: agent.agentId, runInBackground: true, startedAt },
					});
					return {
						content: [
							{
								type: "text",
								text: `Started background agent ${agent.agentId}. Completion arrives as a notification.`,
							},
						],
						details: { agentId: agent.agentId, runInBackground: true, startedAt },
					};
				}

				// ── Foreground: block until completion ──
				if (!started.ok) {
					await agent.stop().catch(() => {});
					return {
						content: [{ type: "text", text: started.error }],
						details: {},
						isError: true,
					};
				}

				onUpdate?.({
					content: [{ type: "text", text: "Working\u2026" }],
					details: { task, startedAt },
				});

				const completion = await agent.waitForCompletion();
				await agent.stop().catch(() => {});
				signal?.removeEventListener("abort", onAbort);

				if (completion.status === "failed") {
					return {
						content: [{ type: "text", text: completion.output || "Sub-agent failed." }],
						details: { task, startedAt, endedAt: Date.now() },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: completion.output }],
					details: {
						task,
						sessionPath: completion.sessionPath,
						sessionId: completion.sessionId,
						startedAt,
						endedAt: Date.now(),
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

		async execute(_toolCallId, raw) {
			const params = raw as AgentControlParams;
			// The registry stores full AgentProcess objects — the narrow
			// RegisteredAgent surface is the seam; steer needs the whole child.
			const agent = registry.lookup(params.agent_id) as AgentProcess | undefined;

			if (!agent) {
				return {
					content: [{ type: "text", text: `Agent ${params.agent_id} not found or already finished.` }],
					details: {},
					isError: true,
				};
			}

			// Runtime validation (schema union may be downgraded by some providers).
			if (params.action !== "steer" && params.action !== "stop") {
				return {
					content: [{ type: "text", text: 'action must be "steer" or "stop".' }],
					details: {},
					isError: true,
				};
			}

			if (params.action === "stop") {
				await registry.stopAndRemove(params.agent_id);
				return {
					content: [{ type: "text", text: `Stopped agent ${params.agent_id}.` }],
					details: { agentId: params.agent_id, action: "stop", title: agent.title },
				};
			}

			// steer
			const message = params.message?.trim();
			if (!message) {
				return {
					content: [{ type: "text", text: '`message` is required when action is "steer".' }],
					details: {},
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
					details: {},
					isError: true,
				};
			}

			await agent.steer(message);
			return {
				content: [{ type: "text", text: `Steered agent ${params.agent_id}.` }],
				details: { agentId: agent.agentId, action: "steer", title: agent.title, message },
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
