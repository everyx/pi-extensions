/**
 * pi-subagent — spawn isolated sub‑agent pi instances + in-tree messaging.
 *
 * Architecture:
 *   index.ts          — tool registration (agent_spawn / agent_stop / agent_send) + routing glue
 *   protocol.ts       — pure JSONL protocol layer + in-tree routing (tested)
 *   rpc-client.ts     — stateful thin JSONL client (spawn + transport)
 *   event-interpret.ts— raw RpcEvent → AgentEvent adapter (pure, tested)
 *   agent-process.ts  — AgentProcess: one resident `pi --mode rpc` child, semantic API
 *   registry.ts       — AgentRegistry: lifecycle + completion policy + routing (tested)
 *   model.ts          — model-spec → ResolvedModel (testable)
 *   name-gen.ts       — short human-readable agent ids (tested)
 *   spawn-session.ts  — spawn lifecycle (fg/bg/persistent) + outcome classification (tested)
 *   tree-anchor.ts    — where a tree event lands: forward or widget (tested)
 *   tree-display.ts   — subtree display anchor: fold / forward / widget (显示面统一规则)
 *   notification.ts   — completion-notification payloads (notifyCompletion)
 *   pending.ts        — queued-report lines: a notification that pi has not
 *                       delivered yet (tested)
 *   types.ts          — shared tool-output / notification shapes
 *   views.ts          — tool card views (single source for the three cards)
 *   card.ts           — notification card wrappers (via pi-ui)
 *   render.ts         — notification card renderer (message surface)
 *   widget.ts         — Agents status widget
 *
 * Every sub‑agent is a resident `pi --mode rpc` child with a persisted
 * session. agent_spawn returns an agent_id immediately and the result arrives
 * as a completion notification (`customType: "subagent-notification"`,
 * deliverAs "steer"). agent_send messages flow along tree edges
 * (parent↔child); persistent agents stay resident (idle, zero token) and can
 * be woken by a message.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentCompletion, AgentProcess, resumePathError } from "./agent-process.js";
import { TOOL_COPY } from "./copy.js";
import { type AgentActivity, type AgentTreeEvent, MSG_STATUS_KEY, TREE_STATUS_KEY } from "./event-interpret.js";
import { createLiveChannels } from "./live-output.js";
import { createLiveTree } from "./live-tree.js";
import { resolveModel } from "./model.js";
import { NOTIFICATION_CUSTOM_TYPE, notifyCompletion } from "./notification.js";
import { PendingReports } from "./pending.js";
import { type AgentMessage, formatFrom } from "./protocol.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import { renderNotification } from "./render.js";
import { finishWhenDrained, runSpawnSession, type SpawnOutcome } from "./spawn-session.js";
import { createSubtreeDisplay } from "./tree-display.js";
import type { SubagentDetails } from "./types.js";
import { atId, sendView, spawnView, stopView } from "./views.js";
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

/** How long to let pi hand settle-time messages to the model before deciding a
 *  report was lost — long enough for a queued delivery to land and settle its
 *  line, short enough that a lost report arrives in the same breath. */
const REDELIVERY_DELAY_MS = 500;

/** TUI-only status widget (created lazily, tui mode only) — a VIEW of the
 *  live tree below, never a source of lifecycle truth. */
let widget: AgentWidget | null = null;

/** Who is alive and under whom — the drain rule's only source of truth.
 *  Extension scope, mode-independent: sub-agents run in rpc mode with no
 *  widget at all, and they still must know their own subtree is busy. */
const liveTree = createLiveTree();

/**
 * Queued-report lines above the editor (created lazily, tui mode only) — the
 * completion reports pi has not handed to the model yet. Same lazy doctrine as
 * the widget: created on first use, because a notification can fire long after
 * the tool call that spawned the agent returned.
 */
let pending: PendingReports | null = null;

function ensurePending(ctx: { mode: string; ui: unknown }): void {
	if (pending || ctx.mode !== "tui") return;
	// biome-ignore lint/suspicious/noExplicitAny: ExtensionUIContext shape from pi
	pending = new PendingReports(ctx.ui as any);
}

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

/**
 * Registry seam. Lifecycle always runs — the live tree is updated whether or
 * not a TUI exists — and drawing is the only part that needs a widget.
 *
 * Keeping these together (rather than skipping the whole adapter in rpc mode)
 * is what makes the drain rule mode-independent: every sub-agent runs headless
 * and would otherwise never forget a dead child, waiting on it forever.
 */
function widgetSurface(): WidgetSurface {
	const w = widget;
	return {
		add: (agent, status) => {
			liveTree.add(agent.agentId, MY_AGENT_ID);
			w?.add(agent as AgentProcess, status);
		},
		// A dead agent's whole subtree is dead: the processes die with it and
		// never report their own removal, so row cleanup follows the same
		// cascade the live tree just computed.
		remove: (agentId, result) => {
			const ids = liveTree.remove(agentId);
			if (!w) return;
			for (const id of ids) w.remove(id, id === agentId ? result : "stopped");
		},
		setStatus: (agentId, status) => w?.setStatus(agentId, status),
		dispose: () => w?.dispose(),
	};
}

// ─── Tool parameter schemas ──────────────────────────────

/**
 * Tree telemetry (nested agents): a sub-agent's own spawns are invisible to
 * the user — the only TUI is the root session's. Every node reports ALL its
 * spawns upward over the same setStatus transport as @parent messages;
 * intermediate nodes forward verbatim (depth + 1). Only the root applies
 * them, as widget rows at the forwarded depth (SPEC: 显示面统一规则).
 */
function createTreeTelemetry(hasParent: boolean) {
	/** Ids reported as added — guards activity/remove so unknown ids never
	 *  emit telemetry. */
	const tracked = new Set<string>();
	const report = (event: AgentTreeEvent) => uiRef?.setStatus(TREE_STATUS_KEY, JSON.stringify(event));
	return {
		report,
		add(agent: { agentId: string; label: string; startedAt: number }, status: "running" | "idle"): void {
			if (!hasParent) return;
			tracked.add(agent.agentId);
			// `parent` is my own id: I am the direct parent of every child I spawn.
			// Forwarding nodes pass the event through verbatim, so the link stays
			// anchored at the real parent however deep the chain runs.
			report({
				op: "add",
				id: agent.agentId,
				label: agent.label,
				startedAt: agent.startedAt,
				depth: 1,
				status,
				parent: MY_AGENT_ID,
			});
		},
		activity(agent: { agentId: string; getLatestActivity(): AgentActivity | undefined }): void {
			if (!tracked.has(agent.agentId)) return;
			const activity = agent.getLatestActivity();
			if (!activity) return;
			report({ op: "activity", id: agent.agentId, activity });
		},
		remove(agentId: string, status: "done" | "failed" | "stopped"): void {
			if (!tracked.delete(agentId)) return;
			report({ op: "remove", id: agentId, status });
		},
	};
}

/** agent_spawn tool params (schema static shape). */
interface SpawnParams {
	prompt: string;
	label: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	timeoutMs?: number;
	persistent?: boolean;
	/** Existing session file to continue (see agent_spawn.resume). */
	resume?: string;
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

// agent_spawn parameter fields — one set, every session. Descriptions live in
// copy.ts (one reviewable block); a parameter whose name says it all has none.
const spawnCopy = TOOL_COPY.agent_spawn;
const SpawnPromptField = Type.String();
const SpawnLabelField = Type.String();
const SpawnModelField = Type.Optional(Type.String({ description: spawnCopy.paramDescriptions.model }));
const SpawnThinkingField = Type.Optional(
	StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
		description: spawnCopy.paramDescriptions.thinking,
	}),
);
const SpawnToolsField = Type.Optional(Type.Array(Type.String(), { description: spawnCopy.paramDescriptions.tools }));
const SpawnTimeoutField = Type.Optional(
	Type.Integer({ minimum: 1, description: spawnCopy.paramDescriptions.timeoutMs }),
);

/**
 * Every spawn returns immediately: the call hands back an agent id and the
 * result arrives as a notification. Nothing waits on a child, so the caller's
 * turn never blocks on a sub-agent — the same shape at every depth.
 *
 * `persistent` is orthogonal: it decides what happens AFTER a result (stay
 * resident for follow-ups vs exit), not whether the spawn waits. A sub-agent's
 * residents live as long as the sub-agent does.
 */
export function buildSpawnParamsSchema(): ReturnType<typeof Type.Object> {
	return Type.Object({
		prompt: SpawnPromptField,
		label: SpawnLabelField,
		model: SpawnModelField,
		thinking: SpawnThinkingField,
		tools: SpawnToolsField,
		timeoutMs: SpawnTimeoutField,
		resume: Type.Optional(Type.String({ description: spawnCopy.paramDescriptions.resume })),
		persistent: Type.Optional(Type.Boolean({ description: spawnCopy.paramDescriptions.persistent })),
	});
}

const SpawnParamsSchema = buildSpawnParamsSchema();

const StopParamsSchema = Type.Object({
	agent_id: Type.String({ description: TOOL_COPY.agent_stop.paramDescriptions.agent_id }),
});

const SendParamsSchema = Type.Object({
	to: Type.String({ description: TOOL_COPY.agent_send.paramDescriptions.to }),
	message: Type.String(),
});

// ─── Helpers ─────────────────────────────────────────────────

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
		notify: (agent, completion) => deliverNotification(agent, completion),
		getWidget: () => widgetSurface(),
		hasParent: HAS_PARENT,
	});

	/**
	 * Hand a completion notification to pi and show it as queued until its card
	 * lands. The two are one delivery: pending.ts owns why the gap exists, pi
	 * owns when it closes (message_end).
	 */
	function deliverNotification(agent: RegisteredAgent, completion: AgentCompletion): void {
		pending?.add(agent, completion);
		notifyCompletion(pi, agent, completion);
	}

	// Inbound messages (a child addresses @parent, forwards a sibling's
	// message, or reports an unroutable target) land here from its rpc event
	// stream and re-enter the router on this hop.
	const onChildMessage = (msg: AgentMessage): void => {
		void handleMessage(pi, registry, msg, false);
	};

	// Tree telemetry for this node's own children (up-report) and forwarding
	// of deeper events. Lives at extension scope: the tracked-set must span
	// executes (a background child reports activity long after its execute returned).
	const tree = createTreeTelemetry(HAS_PARENT);

	// ── agent_spawn ────────────────────────────────────
	pi.registerTool({
		name: "agent_spawn",
		label: "Agent Spawn",
		description: spawnCopy.description,
		promptSnippet: spawnCopy.snippet,
		promptGuidelines: [...spawnCopy.guidelines],
		parameters: SpawnParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as unknown as SpawnParams;
			// Label is cosmetic — it names the session, card, and notifications,
			// and never changes what the agent does.
			const label = params.label?.trim();
			if (!label) {
				return {
					content: [{ type: "text", text: "`label` is required." }],
					details: { error: "`label` is required." },
					isError: true,
				};
			}
			const task = params.prompt?.trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "`prompt` is required." }],
					details: { error: "`prompt` is required." },
					isError: true,
				};
			}

			// Resume: continue an existing session file (the path a previous
			// completion notification reported). Validated here so the model gets
			// one clear error instead of a child that dies on startup.
			const resume = params.resume?.trim();
			const resumeError =
				resume === undefined
					? undefined
					: resume === ""
						? "`resume` must be a session file path"
						: resumePathError(resume);
			if (resumeError) {
				return {
					content: [{ type: "text", text: resumeError }],
					details: { error: resumeError },
					isError: true,
				};
			}

			const resolved = resolveModel(ctx.modelRegistry, ctx.model, params.model);
			if (resolved.error) {
				// Background: render as the status line `Agent <label> start failed:
				// <reason>` (the id never exists yet — spawn didn't happen).
				return {
					content: [{ type: "text", text: resolved.error }],
					details: { error: resolved.error },
					isError: true,
				};
			}

			const startedAt = Date.now();

			// Where my child's subtree telemetry lands: forward to my parent, or
			// surface on the root widget. One module owns the decision.
			const subtree = createSubtreeDisplay({
				hasParent: HAS_PARENT,
				live: liveTree,
				getWidget: () => {
					ensureWidget(ctx);
					return widget ?? undefined;
				},
				forward: (event) => tree.report(event),
			});
			// Short human-name id (max, zoe…) — the LLM-facing reference. No tree
			// structure: agents address only ids they were given, hop by hop.
			const agentId = registry.nextAgentId();
			// Wake-turn ending → completion notification. The assembly is
			// identical for both endings except status/output-default.
			const notifyWake = async (status: "completed" | "failed"): Promise<void> => {
				const [output, stats] = await Promise.all([agent.lastOutput(), agent.getStats()]);
				deliverNotification(agent, {
					status,
					output: output || (status === "failed" ? "Follow-up turn failed (model API error)." : output),
					stats: {
						tokens: stats?.tokens ?? 0,
						toolUses: stats?.toolUses ?? 0,
						durationMs: Date.now() - agent.startedAt,
					},
					sessionPath: agent.sessionPath,
					sessionId: agent.sessionId,
				});
			};
			const live = createLiveChannels({
				// getWidget, not widget: the widget is created on first use, so a
				// captured reference would be null for every update before that.
				surfaces: { getWidget: () => widget ?? undefined, tree },
			});

			const agent = new AgentProcess({
				agentId,
				cwd: ctx.cwd,
				model: resolved.model,
				thinking: params.thinking ?? pi.getThinkingLevel(),
				tools: params.tools,
				label,
				sessionDir: SUBAGENT_SESSION_DIR,
				resumeSessionPath: resume,
				timeoutMs: params.timeoutMs,
				// Resident after completion (idle, zero token) — explicit opt-in.
				persistent: params.persistent,
				// Identity for in-tree messaging: PI_SUBAGENT_AGENT_ID marks this
				// process as a child (agent_send is registered on every instance).
				env: {
					PI_SUBAGENT_AGENT_ID: agentId,
				},
				// Child→parent messages re-enter the router on this hop. Tree telemetry
				// from deeper spawns forwards up (depth + 1) or lands on the root widget.
				onMessage: onChildMessage,
				onTreeEvent: (event) => subtree.onTreeEvent(event),
				// A wake finished. Completed: its output must reach this spawner's
				// context — symmetric with the first-completion notification, an
				// agent_send "delivered" alone would leave the answer unread.
				// Deliberate stops stay silent (stoppedByControl). A failed
				// follow-up is reported (abnormal end) then cleaned up.
				onIdle: (outcome) => {
					if (outcome === "completed") {
						if (!agent.stoppedByControl) {
							void notifyWake("completed").catch(() => {}); // best-effort: must not crash the host
						}
						registry.markIdle(agentId);
						return;
					}
					void notifyWake("failed")
						.then(() => tree.remove(agentId, "failed"))
						.then(() => registry.stopAndRemove(agentId))
						.catch(() => {}); // best-effort: a cleanup failure must not crash the host
				},
				// Where live output goes lives in live-output.ts: the widget row and
				// the tree telemetry hear about every update.
				onDelta: (delta) => live.onDelta(agent, delta),
				onActivityChange: (activity) => live.onActivity(agent, activity),
			});

			// Lifecycle lives in spawn-session.ts — this switch only formats
			// outcomes into tool results; classification rules are table-tested
			// in test/spawn-session.test.ts.
			let outcome: SpawnOutcome;
			try {
				outcome = await runSpawnSession(agent, {
					task,
					signal,
					hooks: {
						onStarting: () =>
							onUpdate?.({
								content: [{ type: "text", text: `Starting ${agent.label}\u2026` }],
								details: {
									label: agent.label,
									model: agent.model,
									thinking: agent.thinking,
								} satisfies SubagentDetails,
							}),
						// The child accepted the task: wire widget + registry + the
						// completion chain here (mechanisms stay on this side of the seam).
						onStarted: (a) => {
							ensureWidget(ctx); // widget row added via the registry (non-TUI: no-op)
							ensurePending(ctx);
							registry.register(a as AgentProcess);
							tree.add(a, "running"); // up-report: my child exists
							void a
								.waitForCompletion()
								.then((completion) =>
									finishWhenDrained({
										agentId: a.agentId,
										live: liveTree,
										onHeld: () => registry.markIdle(a.agentId),
										finish: () => {
											tree.remove(
												a.agentId,
												completion.status === "completed"
													? "done"
													: completion.status === "failed"
														? "failed"
														: "stopped",
											);
											registry.complete(a as AgentProcess, completion);
										},
									}),
								)
								// Defensive: waitForCompletion is deadline-bounded and never
								// rejects today — if it ever does, clean up without notifying.
								.catch(() => {
									tree.remove(a.agentId, "stopped");
									registry.stopAndRemove(a.agentId);
								});
						},
					},
				});
			} catch (err) {
				return toErrorResult(err);
			}

			switch (outcome.kind) {
				case "spawn-failed":
					// The isError return carries the failure to the LLM and the status
					// line shows it to the user — no follow-up notification on top.
					return spawnErrorResult(outcome, { label: agent.label });

				case "started": {
					onUpdate?.({
						content: [{ type: "text", text: `Started ${agent.label}` }],
						details: {
							label: agent.label,
							model: agent.model,
							thinking: agent.thinking,
							startedAt,
						} satisfies SubagentDetails,
					});
					return {
						content: [
							{
								type: "text",
								text: `Started agent @${agent.agentId}. Its result arrives as a notification.`,
							},
						],
						details: {
							label: agent.label,
							model: agent.model,
							thinking: agent.thinking,
							startedAt,
						} satisfies SubagentDetails,
					};
				}
			}
		},

		...spawnView,
	});

	// ── agent_stop ───────────────────────────────────────
	pi.registerTool({
		name: "agent_stop",
		label: "Stop Agent",
		description: TOOL_COPY.agent_stop.description,
		promptSnippet: TOOL_COPY.agent_stop.snippet,
		promptGuidelines: [...TOOL_COPY.agent_stop.guidelines],
		parameters: StopParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate) {
			// No captureUi here: agent_stop never sends upward (no child→parent path).
			const params = raw as StopParams;
			// Honour the @ reference form we teach — strip once, use everywhere
			// (lookup, stopAndRemove, details) so no @@ double prefix appears.
			const agentId = params.agent_id.replace(/^@/, "");
			const agent = registry.lookup(agentId);

			if (!agent) {
				// Card title needs the id: details.agentId drives titleFrom (the
				// args key is snake_case agent_id, which titleFrom does not read).
				return {
					content: [{ type: "text", text: `agent ${params.agent_id} is not running any more.` }],
					details: { agentId, error: `agent ${params.agent_id} is not running any more` },
					isError: true,
				};
			}

			// Partial update first — drives the `⠋ agent_stop <label> stopping…`
			// spinner line while the child is being stopped.
			onUpdate?.({
				content: [{ type: "text", text: `Stopping ${agent.label}\u2026` }],
				details: { label: agent.label, agentId },
			});
			try {
				const stopped = await registry.stopAndRemove(agentId);
				if (stopped) tree.remove(agentId, "stopped");
				if (!stopped) {
					// Finished between lookup and removal (rare) — don't claim
					// a stop that never happened.
					const message = `agent ${params.agent_id} had already finished.`;
					return {
						content: [{ type: "text", text: message }],
						details: { agentId, label: agent.label, error: message },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Stopped agent @${agentId}.` }],
					details: { agentId, label: agent.label },
				};
			} catch (err) {
				// Child died mid-stop (e.g. write-after-end): surface it as a
				// proper status line, not a bare thrown error.
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: message }],
					details: { agentId, label: agent.label, error: message },
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
		description: TOOL_COPY.agent_send.description,
		promptSnippet: TOOL_COPY.agent_send.snippet,
		promptGuidelines: [...TOOL_COPY.agent_send.guidelines],
		parameters: SendParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			captureUi(ctx);
			// A wake reports through the notification path — its cards queue the
			// same way a background spawn's do.
			ensurePending(ctx);
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
				content: [{ type: "text", text: `Sending to ${atId(target)}\u2026` }],
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
				content: [{ type: "text", text: `${r.verb} to ${atId(target)}.` }],
				// Card title shows @id — target label (uniform with agent_stop).
				details: {
					to: target,
					message,
					label: registry.lookup(target)?.label,
					agentId: registry.lookup(target)?.agentId,
				},
			};
		},

		...sendView,
	});

	// ── Notification card (user side) ───────────────────
	pi.registerMessageRenderer(NOTIFICATION_CUSTOM_TYPE, renderNotification);

	// The card lands only when pi hands the queued message to the model —
	// that message event IS the card appearing, so it settles the queued report
	// line (pending.ts). Until then the line is the only trace of the result.
	pi.on("message_end", async (event) => {
		pending?.settle(event.message);
	});

	// A report that never landed gets another chance. pi settles a run only
	// when nothing queued will run, so a line still waiting here was lost, not
	// delayed: Esc wipes the queue it was riding (restoreQueuedMessagesToEditor
	// → agent.clearAllQueues, and our message is not in the session-level list
	// it restores to the editor), and a run that fails to start drops it before
	// it is ever queued. Both are invisible from an extension — the missing card
	// is the only evidence, and it is enough to retry.
	pi.on("agent_settled", async () => {
		const settledAt = Date.now();
		// Deferred: pi hands settle-time messages to the model immediately after
		// this event, and re-sending ahead of that would report the same result
		// twice. One turn of the event loop is too early; this is not.
		setTimeout(() => {
			pending?.undelivered(settledAt, (report) => notifyCompletion(pi, report.agent, report.completion));
		}, REDELIVERY_DELAY_MS);
	});

	// ── Cleanup on exit ─────────────────────────────────
	pi.on("session_shutdown", async (event) => {
		// Quit: the whole process is ending. Reload: pi rebuilds the extension
		// runtime in the same process — emitSessionShutdownEvent(reason:"reload")
		// fires on the OLD runner before it is invalidated, so this handler still
		// owns the registry and can stop its sub-agents cleanly; otherwise a
		// /reload would leave resident rpc children whose stdin pipe stays open.
		if (event.reason !== "quit" && event.reason !== "reload") return;

		// Every tracked agent is about to die with this process, and the model
		// is the only party who does not know: its context still says these
		// agents are running. Write that fact into the transcript as a custom
		// message — the same shape pi uses for compaction summaries, and for
		// the same reason: a session-scoped fact that must still be true when
		// the session comes back. display:false keeps it out of the user's
		// view; it costs ~15 tokens once, and only when it is not empty.
		const survivors = registry.survivors();
		if (survivors.length > 0) {
			pi.sendMessage(
				{
					customType: "subagent-session-end",
					content: `These agents ended with the session and are no longer addressable: ${survivors.join(", ")}.`,
					display: false,
				},
				{ triggerTurn: false },
			);
		}

		// Graceful stop of every tracked agent. Children exit on their own
		// (stdin EOF → rpc shutdown) even if the parent dies first, because
		// the pipe closes — no tmux, no disk cleanup, no signals.
		await registry.shutdown();
		pending?.dispose();
	});
}
