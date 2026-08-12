/**
 * pi-subagent — spawn isolated sub‑agent pi instances + in-tree messaging.
 *
 * Architecture (issue #10/#13):
 *   index.ts          — tool registration (agent_spawn / agent_stop / agent_send) + routing glue
 *   protocol.ts       — pure JSONL protocol layer + in-tree routing (tested)
 *   rpc-client.ts     — stateful thin JSONL client (spawn + transport)
 *   event-interpret.ts— raw RpcEvent → AgentEvent adapter (pure, tested)
 *   agent-process.ts  — AgentProcess: one resident `pi --mode rpc` child, semantic API
 *   registry.ts       — AgentRegistry: lifecycle + completion policy + routing (tested)
 *   model.ts          — model-spec → ResolvedModel (testable)
 *   render.ts         — TUI rendering + notification card renderer
 *   widget.ts         — Agents status widget
 *
 * Every sub‑agent is a resident `pi --mode rpc` child with a persisted
 * session. Foreground agent_spawn calls block until completion; background
 * calls return an agent_id immediately and deliver a completion notification
 * (`customType: "subagent-notification"`, deliverAs "followUp") carrying the
 * final output. agent_send messages flow along tree edges (parent↔child);
 * persistent agents stay resident (idle, zero token) and can be woken by a
 * message.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentCompletion, AgentProcess } from "./agent-process.js";
import { type AgentActivity, MSG_STATUS_KEY } from "./event-interpret.js";
import { resolveModel } from "./model.js";
import { type AgentMessage, formatFrom } from "./protocol.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import { renderNotification } from "./render.js";
import type { NotificationDetails } from "./types.js";
import { sendView, spawnView, stopView } from "./views.js";
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

// ─── In-tree identity ──────────────────────────────────────

/** This process's agent id ("" = root session). Injected by the parent at spawn. */
const MY_AGENT_ID = process.env.PI_SUBAGENT_AGENT_ID ?? "";
/** I am a child agent when an identity was injected (root children get "a1"…). */
const HAS_PARENT = MY_AGENT_ID !== "";

/** TUI-only background-agent status widget (created lazily, tui mode only). */
let widget: AgentWidget | null = null;

/**
 * Lazily-captured UI handle for the child→parent channel (extension_ui_request /
 * setStatus under the reserved key). Tool executes refresh it every call —
 * a sub-agent that spawned children has run its own execute first, so the
 * ref is always warm before any inbound @parent message needs to go up.
 */
let uiRef: { setStatus(key: string, text: string | undefined): void } | undefined;

function ensureWidget(ctx: { mode: string; ui: unknown }): AgentWidget | null {
	captureUi(ctx);
	if (widget) return widget;
	if (ctx.mode !== "tui") return null;
	// biome-ignore lint/suspicious/noExplicitAny: ExtensionUIContext shape from pi
	widget = new AgentWidget(ctx.ui as any);
	return widget;
}

/**
 * Refresh the child→parent handle from any tool execute. Every execute runs
 * with a UI context (rpc children too — their setStatus emits the
 * extension_ui_request event stream the parent consumes), and a sub-agent
 * must have run its own execute before it can spawn children, so the ref
 * is always warm before any inbound @parent message needs to go up.
 */
function captureUi(ctx: { mode: string; ui: unknown }): void {
	uiRef = ctx.ui as { setStatus(key: string, text: string | undefined): void };
}

/** Narrow TUI adapter: AgentWidget → WidgetSurface (registry seam). */
function widgetSurface(): WidgetSurface | null {
	const w = widget;
	if (!w) return null;
	return {
		add: (agent) => w.add(agent as AgentProcess),
		remove: (agentId, result) => w.remove(agentId, result),
		setStatus: (agentId, status) => w.setStatus(agentId, status),
		dispose: () => w.dispose(),
	};
}

// ─── Tool parameter schemas ──────────────────────────────────

/** agent_spawn tool params (schema static shape). */
interface SpawnParams {
	prompt: string;
	title: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	run_in_background?: boolean;
	timeoutMs?: number;
	persistent?: boolean;
}

/** agent_stop tool params. */
interface StopParams {
	agent_id: string;
}

/** agent_send tool params. */
interface SendParams {
	to: string;
	message: string;
}

const SpawnParamsSchema = Type.Object({
	prompt: Type.String({
		description: "The task for the sub-agent (self-contained: it starts with zero context).",
	}),
	title: Type.String({
		minLength: 1,
		description:
			"Short task title (3-5 words) — required. Identifies the agent in the UI, " +
			"notification card, and session name.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Model for the sub-agent — provider/modelId or fuzzy name (e.g. "haiku", "sonnet"). ' +
				"Omit to inherit your current model — don't switch the model unless the task " +
				"explicitly requires it.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
			description:
				'Reasoning intensity for the sub-agent ("off"…"max"). ' +
				"Omit to inherit your current thinking level — don't change it unless the task " +
				"requires a different depth.",
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
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"If true, keep the agent resident after it completes (idle, zero token) so you can " +
				"send it follow-up messages later — the process stays alive until you stop it. " +
				"Default false (the agent exits when done).",
		}),
	),
});

const StopParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The agent id to stop (e.g. "@max").' }),
});

const SendParamsSchema = Type.Object({
	to: Type.String({
		description:
			'The agent id from agent_spawn (e.g. "@max" — a spawn result or completion ' +
			'notification carries it), or "@parent" to message the session that spawned you.',
	}),
	message: Type.String({ description: "The message text." }),
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

/**
 * When an output exceeds the context cap, stash the full text in a temp file
 * and return the LLM-visible marker (embedded in the result, no extra field):
 * the model reads the truncated preview and knows the full output is one
 * `read` away. Returns the marker when truncated, "" otherwise.
 */
function maybeWriteFullOutput(agentId: string, output: string): string {
	const truncated = truncateForContext(output);
	if (truncated === output) return "";
	const file = `/tmp/pi-subagent-${agentId}.txt`;
	try {
		// Best-effort: a write failure must never break the notification.
		require("node:fs").writeFileSync(file, output, "utf8");
	} catch {
		return "";
	}
	return `\n\n(output truncated — full output: ${file})`;
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

/**
 * Route one in-tree message through the tree (per-hop O(1) against my
 * direct children). Shared by the agent_send tool (outbound: the caller
 * gets a synchronous result) and the inbound handler (child→parent: no
 * return path, so errors are delivered back to the sender as messages).
 *
 *   direct child → rpc prompt + steer (wakes idle, queues on running)
 *   "@parent"   → the parent injects it into its LLM (or mine, inbound)
 *   unknown     → explicit error (routing is the LLM's job, hop by hop);
 *                 on the inbound path the sender is told best-effort
 */
async function handleMessage(
	pi: ExtensionAPI,
	registry: AgentRegistry,
	msg: AgentMessage,
	outbound: boolean,
): Promise<{ ok: boolean; verb?: string; error?: string }> {
	const d = registry.route(msg);
	switch (d.kind) {
		case "child": {
			// Point-to-point delivery to a direct child. Cross-level coordination
			// is the LLM's job: it addresses only ids it knows, hop by hop.
			const text = `${formatFrom(d.message.from)}${d.message.message}`;
			const ok = await registry.deliver(d.childId, text);
			return ok ? { ok: true, verb: "delivered" } : { ok: false, error: `delivery to ${d.childId} failed` };
		}
		case "parent": {
			if (outbound) {
				// I am addressing my own parent — point-to-point up; the parent's
				// extension injects it into its LLM session.
				uiRef?.setStatus(MSG_STATUS_KEY, JSON.stringify(d.message));
				return { ok: true, verb: "delivered" };
			}
			// My child addressed "@parent" (= me): inject into my session.
			pi.sendMessage(
				{
					customType: "subagent-message",
					content: `${formatFrom(d.message.from)}${d.message.message}`,
					display: true,
					details: { from: d.message.from, message: d.message.message },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			return { ok: true, verb: "delivered" };
		}
		case "error": {
			if (!outbound && msg.from) {
				// Inbound path, no return channel: tell the sender (best-effort).
				void registry.deliver(msg.from, `[pi-subagent] agent_send to ${msg.to} failed: ${d.reason}`);
			}
			return { ok: false, error: d.reason };
		}
	}
}

/** One-shot cleanup shared by every exit path: detach the abort handler, then stop the child. */
async function teardownAgent(agent: AgentProcess, signal: AbortSignal | undefined, onAbort: () => void): Promise<void> {
	signal?.removeEventListener("abort", onAbort);
	await agent.stop().catch(() => {});
}

/** Deliver a completion notification: JSON content (LLM) + rich details (user card). */
function notifyCompletion(pi: ExtensionAPI, agent: RegisteredAgent, completion: AgentCompletion): void {
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

// ─── Default export (pi extension entry) ───────────────────────

export default function (pi: ExtensionAPI) {
	// pi's agent-core drops the execute() isError flag when a tool returns
	// normally (bash gets its error background by throwing instead) — see
	// agent-core executePreparedToolCall. Re-attach it for our tools by
	// marking every error path in `details.error`; the handler restores
	// isError so failed calls render with toolErrorBg like bash, while
	// keeping the details (status line) intact.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "agent_spawn" && event.toolName !== "agent_stop" && event.toolName !== "agent_send") {
			return undefined;
		}
		const details = event.details as { error?: unknown } | undefined;
		if (!details || details.error === undefined) return undefined;
		return { isError: true };
	});

	// One registry per session: owns the running-agent bookkeeping, the
	// completion policy (notify unless user-stopped; cleanup on every path),
	// and the in-tree routing (direct children only — per-hop O(1)).
	const registry = new AgentRegistry({
		notify: (agent, completion) => notifyCompletion(pi, agent, completion),
		getWidget: () => widgetSurface(),
		hasParent: HAS_PARENT,
	});

	// Inbound messages (a child addresses @parent, forwards a sibling's
	// message, or reports an unroutable target) land here from its rpc event
	// stream and re-enter the router on this hop.
	const onChildMessage = (msg: AgentMessage): void => {
		void handleMessage(pi, registry, msg, false);
	};

	// ── agent_spawn ────────────────────────────────────
	pi.registerTool({
		name: "agent_spawn",
		label: "Agent Spawn",
		description:
			"Spawn an isolated sub-agent in its own context window. The sub-agent starts with " +
			"zero context, so the prompt must be self-contained: include file paths, constraints, " +
			"and the expected output shape. Foreground (run_in_background: false) blocks until it " +
			"finishes and returns the output directly. Background (run_in_background: true) returns " +
			"an agent id immediately; the completion notification carries the result (status + " +
			"agent id + final output) — you can intervene with agent_stop / agent_send while it " +
			"runs. persistent: true keeps it resident (idle) after completion — message it later " +
			"to continue the same context.",
		promptSnippet: "Spawn an isolated sub-agent for heavy, parallel, or context-heavy work",
		promptGuidelines: [
			"Use agent_spawn when a task would flood your context with verbose intermediate output — the sub-agent keeps it in its own window and returns only its final output.",
			"Use agent_spawn for independent parallel work: several foreground calls already run in parallel. Reserve run_in_background: true for when you need to keep working or reply to the user while the sub-agent runs.",
			"Write agent_spawn prompts self-contained: the sub-agent has zero context — include paths, constraints, and the expected output shape.",
			"Never poll a background agent — its completion notification carries the result.",
			"Long outputs are truncated for your context; when that happens the result carries the full-output file path — read it when you need everything.",
			"Keep a persistent agent for follow-ups: spawn once with persistent: true, then agent_send it new instructions — the context stays alive (idle until woken).",
		],
		parameters: SpawnParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as SpawnParams;
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
			// Short human-name id (max, zoe…) — the LLM-facing reference. No tree
			// structure: agents address only ids they were given, hop by hop.
			const agentId = registry.nextAgentId();
			const agent = new AgentProcess({
				agentId,
				cwd: ctx.cwd,
				model: resolved.model,
				thinking: params.thinking ?? pi.getThinkingLevel(),
				tools: params.tools,
				title: params.title,
				sessionDir: SUBAGENT_SESSION_DIR,
				timeoutMs: params.timeoutMs,
				// Resident after completion (idle, zero token) — explicit opt-in.
				persistent: params.persistent,
				// Identity + parent reference for in-tree messaging; the child
				// extension only enables agent_send when PI_SUBAGENT_AGENT_ID is set.
				env: {
					PI_SUBAGENT_AGENT_ID: agentId,
					PI_SUBAGENT_PARENT: MY_AGENT_ID,
				},
				// Child→parent messages re-enter the router on this hop.
				onMessage: onChildMessage,
				// A wake finished: completed → idle row; a failed follow-up is
				// reported (abnormal end — not a deliberate stop) then cleaned up.
				onIdle: (outcome) => {
					if (outcome === "completed") {
						registry.markIdle(agentId);
						return;
					}
					void (async () => {
						const [output, stats] = await Promise.all([agent.lastOutput(), agent.getStats()]);
						notifyCompletion(pi, agent, {
							status: "failed",
							output: output || "Follow-up turn failed (model API error).",
							stats: {
								tokens: stats?.tokens ?? 0,
								toolUses: stats?.toolUses ?? 0,
								durationMs: Date.now() - agent.startedAt,
							},
							sessionPath: agent.sessionPath,
							sessionId: agent.sessionId,
						});
						await registry.stopAndRemove(agentId);
					})().catch(() => {}); // best-effort: a cleanup failure must not crash the host
				},
				onDelta: (delta) => {
					if (params.run_in_background) {
						// Live widget excerpt: the latest streamed text tail.
						widget?.updateActivity(agent.agentId, agent.getLatestActivity());
						return;
					}
					streamed += delta;
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: liveDetails(agent.getLatestActivity()),
					});
				},
				onActivityChange: (activity) => {
					if (params.run_in_background) {
						// Live widget excerpt for thinking/tool transitions.
						widget?.updateActivity(agent.agentId, activity);
						return;
					}
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
						await teardownAgent(agent, signal, onAbort);
						return spawnErrorResult(started, { runInBackground: true, title: agent.title });
					}

					// Abort is wired to stop while spawning only; once the spawn
					// settled, the background agent runs on its own — the user
					// controls it via agent_stop, and this (already returned)
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
								text: `Started background agent @${agent.agentId}. Completion arrives as a notification.`,
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
					await teardownAgent(agent, signal, onAbort);
					return spawnErrorResult(started);
				}

				onUpdate?.({
					content: [{ type: "text", text: "Working\u2026" }],
					details: { task, startedAt, model: agent.model, thinking: agent.thinking },
				});

				const completion = await agent.waitForCompletion();

				// persistent: the process stays resident after completion (idle,
				// zero token) and registers so agent_send can wake it later —
				// foreground users already saw the inline result, so there is no
				// follow-up notification (background notifications are the
				// background path's job).
				if (agent.persistent && completion.status === "completed") {
					signal?.removeEventListener("abort", onAbort);
					ensureWidget(ctx);
					registry.register(agent);
					registry.markIdle(agent.agentId);
				} else {
					await teardownAgent(agent, signal, onAbort);
				}

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
					// A persistent foreground agent stays resident — the LLM needs
					// its id to wake it later with agent_send (or stop it).
					content: [
						{
							type: "text",
							text: agent.persistent
								? `${truncateForContext(completion.output)}${maybeWriteFullOutput(agent.agentId, completion.output)}\n\n(agent @${agent.agentId} is resident — send it follow-ups with agent_send)`
								: truncateForContext(completion.output) + maybeWriteFullOutput(agent.agentId, completion.output),
						},
					],
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
				await teardownAgent(agent, signal, onAbort);
				return toErrorResult(err);
			}
		},

		...spawnView,
	});

	// ── agent_stop ───────────────────────────────────────
	pi.registerTool({
		name: "agent_stop",
		label: "Stop Agent",
		description:
			"Terminate a sub-agent: a running agent discards its work; a persistent (idle) " +
			"agent exits and is removed. The completion notification is " +
			"suppressed for deliberate stops.",
		promptSnippet: "Stop a running or idle sub-agent",
		promptGuidelines: [
			"Use agent_stop when a background agent is consuming tokens on a wrong path — stop it and respawn with a corrected prompt.",
			"Stop a persistent agent when you no longer need it — an idle agent still holds a resident process until stopped.",
		],
		parameters: StopParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate) {
			// No captureUi here: agent_stop never sends upward (no child→parent path).
			const params = raw as StopParams;
			// Honour the @ reference form we teach — strip once, use everywhere
			// (lookup, stopAndRemove, details) so no @@ double prefix appears.
			const agentId = params.agent_id.replace(/^@/, "");
			const agent = registry.lookup(agentId);

			if (!agent) {
				return {
					content: [{ type: "text", text: `agent ${params.agent_id} not found or already finished.` }],
					details: { error: `agent ${params.agent_id} not found or already finished` },
					isError: true,
				};
			}

			// Partial update first — drives the `⠋ agent_stop <title> stopping…`
			// spinner line while the child is being stopped.
			onUpdate?.({
				content: [{ type: "text", text: `Stopping ${agent.title}\u2026` }],
				details: { title: agent.title, agentId },
			});
			try {
				const stopped = await registry.stopAndRemove(agentId);
				if (!stopped) {
					// Finished between lookup and removal (rare) — don't claim
					// a stop that never happened.
					const message = `agent ${params.agent_id} already finished.`;
					return {
						content: [{ type: "text", text: message }],
						details: { agentId, title: agent.title, error: message },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Stopped agent @${agentId}.` }],
					details: { agentId, title: agent.title },
				};
			} catch (err) {
				// Child died mid-stop (e.g. write-after-end): surface it as a
				// proper status line, not a bare thrown error.
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: message }],
					details: { agentId, title: agent.title, error: message },
					isError: true,
				};
			}
		},

		...stopView,
	});

	// ── agent_send ──────────────────────────────────────
	pi.registerTool({
		name: "agent_send",
		label: "Send Message",
		description:
			"Send a message to another agent. `to` is the agent id agent_spawn gave you (a spawn " +
			'result or completion notification carries it), or "@parent" to message the session ' +
			"that spawned you. Messages wake idle persistent agents and queue on running ones — " +
			"the message lands in the target's context.",
		promptSnippet: "Send a message to a sub-agent or your parent",
		promptGuidelines: [
			"Send follow-up instructions to a persistent agent with agent_send — its context is intact and it wakes to handle the message.",
			"A sub-agent blocked on missing information should agent_send @parent a concise question; the parent replies the same way.",
			"Message ids are the ones you got from agent_spawn (the notification carries agent_id).",
		],
		parameters: SendParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as SendParams;
			const to = params.to?.trim();
			const message = params.message?.trim();
			// Honour the @ reference form we teach — but never strip @parent
			// (the protocol layer routes on the literal value). Plain agent
			// ids get stripped once, so lookup and the card title resolve and
			// no @@ double prefix appears.
			const target = to ? (to === "@parent" ? to : to.replace(/^@/, "")) : to;
			if (!to) {
				return {
					content: [{ type: "text", text: "`to` is required." }],
					details: { error: "`to` is required." },
					isError: true,
				};
			}
			if (!message) {
				return {
					content: [{ type: "text", text: "`message` is required." }],
					details: { error: "`message` is required." },
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Sending to ${target}\u2026` }],
				details: { to: target },
			});
			const r = await handleMessage(pi, registry, { to: target, from: MY_AGENT_ID, message }, true);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: r.error ?? "delivery failed" }],
					details: { to: target, error: r.error },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `${r.verb} to @${target}.` }],
				// Card title shows @id — target title (uniform with agent_stop).
				details: {
					to: target,
					message,
					title: registry.lookup(target)?.title,
					agentId: registry.lookup(target)?.agentId,
				},
			};
		},

		...sendView,
	});

	// ── Notification card (user side) ───────────────────
	pi.registerMessageRenderer("subagent-notification", renderNotification);

	// ── Cleanup on exit ─────────────────────────────────
	pi.on("session_shutdown", async (event) => {
		// Quit: the whole process is ending. Reload: pi rebuilds the extension
		// runtime in the same process — emitSessionShutdownEvent(reason:"reload")
		// fires on the OLD runner before it is invalidated, so this handler still
		// owns the registry and can stop its sub-agents cleanly; otherwise a
		// /reload would leave resident rpc children whose stdin pipe stays open.
		if (event.reason !== "quit" && event.reason !== "reload") return;

		// Graceful stop of every tracked agent. Children exit on their own
		// (stdin EOF → rpc shutdown) even if the parent dies first, because
		// the pipe closes — no tmux, no disk cleanup, no signals.
		await registry.shutdown();
	});
}
