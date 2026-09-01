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
 *   nested-fold.ts    — foreground-card nested-subtree meta counters (tested)
 *   tree-display.ts   — subtree display anchor: fold / forward / widget (显示面统一规则)
 *   notification.ts   — completion-notification payloads (notifyCompletion)
 *   types.ts          — shared tool-output / notification shapes
 *   views.ts          — tool card views (single source for the three cards)
 *   card.ts           — notification card wrappers (via pi-ui)
 *   render.ts         — notification card renderer (message surface)
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentProcess } from "./agent-process.js";
import { type AgentActivity, type AgentTreeEvent, MSG_STATUS_KEY, TREE_STATUS_KEY } from "./event-interpret.js";
import { resolveModel } from "./model.js";
import { maybeWriteFullOutput, notifyCompletion, truncateForContext } from "./notification.js";
import { type AgentMessage, formatFrom } from "./protocol.js";
import { AgentRegistry, type WidgetSurface } from "./registry.js";
import { renderNotification } from "./render.js";
import { runSpawnSession, type SpawnOutcome } from "./spawn-session.js";
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
		add: (agent, status) => w.add(agent as AgentProcess, status),
		remove: (agentId, result) => w.remove(agentId, result),
		setStatus: (agentId, status) => w.setStatus(agentId, status),
		dispose: () => w.dispose(),
	};
}

// ─── Tool parameter schemas ──────────────────────────────

/**
 * Tree telemetry (nested agents): a sub-agent's own spawns are invisible to
 * the user — the only TUI is the root session's. Every node reports ALL its
 * spawns upward (foreground and background alike) over the same setStatus
 * transport as @parent messages; intermediate nodes forward verbatim
 * (depth + 1). Consumption is decided at the anchor boundary — the execute
 * that owns the visible surface:
 *   • root + background child → widget rows (indent = depth)
 *   • root + foreground child → folded into that card's nested meta counters
 * A foreground card's subtree therefore never reaches the widget, and a
 * background row's subtree never leaks into a card — one subtree, one
 * surface (SPEC: 显示面统一规则).
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
			report({ op: "add", id: agent.agentId, label: agent.label, startedAt: agent.startedAt, depth: 1, status });
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

// Shared agent_spawn parameter fields — the root session gets the full set;
// sub-agents get a foreground-only subset (see buildSpawnParamsSchema).
const SpawnPromptField = Type.String({
	description: "The task for the sub-agent.",
});
const SpawnLabelField = Type.String({
	description: "Task label.",
});
const SpawnModelField = Type.Optional(
	Type.String({
		description:
			'Model for the sub-agent — provider/modelId or fuzzy name (e.g. "haiku", "sonnet"). ' +
			"Omit to inherit your current model — don't switch the model unless the task " +
			"explicitly requires it.",
	}),
);
const SpawnThinkingField = Type.Optional(
	StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
		description:
			'Reasoning intensity for the sub-agent ("off"…"max"). ' +
			"Omit to inherit your current thinking level — don't change it unless the task " +
			"requires a different depth.",
	}),
);
const SpawnToolsField = Type.Optional(
	Type.Array(Type.String(), {
		description:
			"Tool allowlist for the sub-agent. Omit to grant all tools. For read-only " +
			"exploration, restrict to read/grep/find/ls and consider a cheaper model.",
	}),
);
const SpawnTimeoutField = Type.Optional(
	Type.Integer({
		minimum: 1,
		description:
			"Optional wall-clock deadline for the whole task, in milliseconds. Omit for no " +
			"time limit (the default — the child runs until it finishes or is stopped). " +
			"Pass a value when you want to bound a risky/looping task; on expiry the agent is " +
			"stopped and the call reports stopped.",
	}),
);

/**
 * Sub-agents never see run_in_background: their lifetime is bounded by the
 * parent's synchronous wait, so a background child could not outlive them nor
 * deliver its result anywhere — it would race the returned answer with forced
 * ack turns. Only the long-lived root session hosts background work. Hiding
 * the parameter beats erroring on it: the misuse cannot happen at all.
 *
 * persistent stays available to everyone: its residency is scoped to the host
 * session by definition ("alive until your session ends") — a sub-agent using
 * an iterative helper within its own lifetime is fully served, and parent
 * exit cleans residents up like any other child.
 */
export function buildSpawnParamsSchema(hasParent: boolean): ReturnType<typeof Type.Object> {
	return Type.Object({
		prompt: SpawnPromptField,
		label: SpawnLabelField,
		model: SpawnModelField,
		thinking: SpawnThinkingField,
		tools: SpawnToolsField,
		timeoutMs: SpawnTimeoutField,
		persistent: Type.Optional(
			Type.Boolean({
				description:
					"If true, keep the agent resident after it completes (idle, zero token) so you can " +
					"send it follow-up messages later — the process stays alive until your session ends " +
					"(a sub-agent's residents are cleaned up when it returns) or until you stop it. " +
					"Default false (the agent exits when done).",
			}),
		),
		...(hasParent
			? {}
			: {
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"If true, return an agent_id immediately and notify you on completion — you can " +
								"keep working meanwhile. If false (default), block until the result is ready. " +
								"Root-only: as a sub-agent you cannot host background work.",
						}),
					),
				}),
	});
}

const SpawnParamsSchema = buildSpawnParamsSchema(HAS_PARENT);

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

	// Tree telemetry for this node's own children (up-report) and forwarding
	// of deeper events. Lives at extension scope: the tracked-set must span
	// executes (a background child reports activity long after its execute returned).
	const tree = createTreeTelemetry(HAS_PARENT);

	// ── agent_spawn ────────────────────────────────────
	pi.registerTool({
		name: "agent_spawn",
		label: "Agent Spawn",
		description: HAS_PARENT
			? "Spawn an isolated sub-agent in your own context window. The call blocks until it " +
				"finishes and returns the output. Background spawns are root-only — your lifetime " +
				"ends when this call returns; persistent helpers are fine and live as long as you do."
			: "Spawn an isolated sub-agent in its own context window. Foreground (run_in_background: " +
				"false) blocks until it finishes and returns the output directly. Background " +
				"(run_in_background: true) returns an agent id immediately; the completion notification " +
				"carries the result (status + agent id + final output) — you can intervene with " +
				"agent_stop / agent_send while it runs. persistent: true keeps it resident (idle) " +
				"after completion — message it later to continue the same context.",
		promptSnippet: "Spawn an isolated sub-agent for heavy, parallel, or context-heavy work",
		promptGuidelines: HAS_PARENT
			? [
					"Use agent_spawn when a task would flood your context with verbose intermediate output — the sub-agent keeps it in its own window and returns only its final output.",
					"For independent parallel work, issue several foreground agent_spawn calls together — they run concurrently.",
					"Write agent_spawn prompts self-contained: the sub-agent has zero context — include paths, constraints, and the expected output shape.",
					"Long outputs are truncated for your context; when that happens the result carries the full-output file path — read it when you need everything.",
				]
			: [
					"Use agent_spawn when a task would flood your context with verbose intermediate output — the sub-agent keeps it in its own window and returns only its final output.",
					"Use agent_spawn for independent parallel work: several foreground calls already run in parallel. Reserve run_in_background: true for when you need to keep working or reply to the user while the sub-agent runs.",
					"Write agent_spawn prompts self-contained: the sub-agent has zero context — include paths, constraints, and the expected output shape.",
					"Never poll a background agent — its completion notification carries the result.",
					"Long outputs are truncated for your context; when that happens the result carries the full-output file path — read it when you need everything.",
				],
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
			// Schema hides run_in_background from sub-agents; this guard catches
			// hallucinated args (schema validation may pass extras through).
			if (HAS_PARENT && params.run_in_background != null) {
				return {
					content: [
						{
							type: "text",
							text:
								"run_in_background is root-only: your lifetime ends when this call returns, so " +
								"background work could not outlive you nor deliver its result. For parallel " +
								"work, issue several foreground agent_spawn calls together (they run " +
								"concurrently); for long-running work, describe it in your reply so the " +
								"caller can decide.",
						},
					],
					details: { error: "background spawns are root-only", label },
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

			const resolved = resolveModel(ctx.modelRegistry, ctx.model, params.model);
			if (resolved.error) {
				// Background: render as the status line `Agent <label> start failed:
				// <reason>` (the id never exists yet — spawn didn't happen).
				return {
					content: [{ type: "text", text: resolved.error }],
					details: params.run_in_background
						? { runInBackground: true, label, error: resolved.error }
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
			// Where my child's subtree telemetry lands (SPEC: 显示面统一规则) —
			// fold into THIS card while it's open, forward to my parent, or
			// surface on the root widget. One module owns the whole decision.
			const subtree = createSubtreeDisplay({
				hasParent: HAS_PARENT,
				foregroundEdge: params.run_in_background !== true,
				getWidget: () => {
					ensureWidget(ctx);
					return widget ?? undefined;
				},
				forward: (event) => tree.report(event),
				onFold: () =>
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: liveDetails(agent.getLatestActivity()),
					}),
			});
			// Live-card details: the shared slice every foreground update carries.
			const liveDetails = (activity?: AgentActivity): SubagentDetails => ({
				task,
				startedAt,
				model: agent.model,
				thinking: agent.thinking,
				activity,
				events: agent.getEvents(),
				nested: subtree.nested(),
			});
			// Short human-name id (max, zoe…) — the LLM-facing reference. No tree
			// structure: agents address only ids they were given, hop by hop.
			const agentId = registry.nextAgentId();
			// Wake-turn ending → completion notification. The assembly is
			// identical for both endings except status/output-default.
			const notifyWake = async (status: "completed" | "failed"): Promise<void> => {
				const [output, stats] = await Promise.all([agent.lastOutput(), agent.getStats()]);
				notifyCompletion(pi, agent, {
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
			const agent = new AgentProcess({
				agentId,
				cwd: ctx.cwd,
				model: resolved.model,
				thinking: params.thinking ?? pi.getThinkingLevel(),
				tools: params.tools,
				label,
				sessionDir: SUBAGENT_SESSION_DIR,
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
				onDelta: (delta) => {
					if (params.run_in_background) {
						// Live widget excerpt: the latest streamed text tail.
						widget?.updateActivity(agent.agentId, agent.getLatestActivity());
						tree.activity(agent);
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
						tree.activity(agent);
						return;
					}
					if (activity.kind === "text") return; // covered by onDelta
					onUpdate?.({ content: [{ type: "text", text: streamed }], details: liveDetails(activity) });
				},
			});

			// Lifecycle lives in spawn-session.ts — this switch only formats
			// outcomes into tool results; classification rules are table-tested
			// in test/spawn-session.test.ts.
			let outcome: SpawnOutcome;
			try {
				outcome = await runSpawnSession(agent, {
					task,
					runInBackground: params.run_in_background === true,
					signal,
					hooks: {
						onWorking: () =>
							onUpdate?.({
								content: [{ type: "text", text: "Working\u2026" }],
								details: { task, startedAt, model: agent.model, thinking: agent.thinking },
							}),
						onBackgroundStarting: () =>
							onUpdate?.({
								content: [{ type: "text", text: `Starting ${agent.label}\u2026` }],
								details: {
									runInBackground: true,
									label: agent.label,
									model: agent.model,
									thinking: agent.thinking,
								} satisfies SubagentDetails,
							}),
						// Background settled: wire widget + registry + the completion
						// chain here (mechanisms stay on this side of the seam).
						onBackgroundSettled: (a) => {
							ensureWidget(ctx); // widget row added via the registry (non-TUI: no-op)
							registry.register(a as AgentProcess);
							tree.add(a, "running"); // up-report: my child exists
							void a
								.waitForCompletion()
								.then((completion) => {
									tree.remove(
										a.agentId,
										completion.status === "completed" ? "done" : completion.status === "failed" ? "failed" : "stopped",
									);
									registry.complete(a as AgentProcess, completion);
								})
								// Defensive: waitForCompletion is deadline-bounded and never
								// rejects today — if it ever does, clean up without notifying.
								.catch(() => {
									tree.remove(a.agentId, "stopped");
									registry.stopAndRemove(a.agentId);
								});
						},
						onResident: (a) => {
							ensureWidget(ctx);
							// Resident from birth: register the widget row as idle (‖
							// marker, stays addressable). Registering an already-completed
							// agent at its terminal status would be removed by the
							// widget's terminal cleanup before markIdle could flip it.
							registry.register(a as AgentProcess, "idle");
							tree.add(a, "idle");
						},
						// Foreground settled: report the child upward (widget-rooted
						// nodes only — at the root the card itself is the display; a
						// card-contained node's subtree folds at its own anchor). This
						// closes the blind spot where a background agent's foreground
						// children were invisible entirely.
						onForegroundSettled: (a) => {
							if (HAS_PARENT) tree.add(a, "running");
						},
					},
				});
			} catch (err) {
				return toErrorResult(err);
			}

			subtree.closeCard(); // from here on onUpdate cannot refresh the card
			switch (outcome.kind) {
				case "spawn-failed":
					// The isError return carries the failure to the LLM and the status
					// line shows it to the user — no follow-up notification on top.
					return spawnErrorResult(outcome, {
						runInBackground: params.run_in_background,
						label: agent.label,
					});

				case "background-started": {
					onUpdate?.({
						content: [{ type: "text", text: `Started ${agent.label} (background)` }],
						details: {
							runInBackground: true,
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
								text: `Started background agent @${agent.agentId}. Completion arrives as a notification.`,
							},
						],
						details: {
							runInBackground: true,
							label: agent.label,
							model: agent.model,
							thinking: agent.thinking,
							startedAt,
						} satisfies SubagentDetails,
					};
				}

				case "finished": {
					// Failures and limit-stops are both errors for the caller: the
					// stopped case (total timeout / hard token limit) must not look
					// like a clean success. A user cancel (abort) also produces a
					// stop — don't blame that on the limits.
					if (outcome.status === "failed" || outcome.status === "stopped") {
						if (HAS_PARENT && !outcome.resident)
							tree.remove(agentId, outcome.status === "failed" ? "failed" : "stopped");
						const message =
							outcome.status === "failed"
								? outcome.output || "Sub-agent failed."
								: outcome.stoppedByControl
									? outcome.output || "Sub-agent stopped."
									: `${outcome.output || "Sub-agent was stopped."}\n(stopped \u2014 reached the task time limit; the output above is partial)`;
						return {
							content: [{ type: "text", text: truncateForContext(message) }],
							details: {
								task,
								startedAt,
								endedAt: outcome.endedAt,
								// Full message (uncapped) — the user reads it on the card,
								// folded but never dropped; the LLM sees the capped copy.
								error: message,
								model: agent.model,
								thinking: agent.thinking,
								sessionPath: outcome.sessionPath,
								events: outcome.events,
								nested: subtree.nested(),
							} satisfies SubagentDetails,
							isError: true,
						};
					}
					if (HAS_PARENT && !outcome.resident) tree.remove(agentId, "done");
					return {
						// Pure text result — no session hint: the output stands alone
						// (the session path is the card footer, recoverable by the user).
						// A persistent foreground agent stays resident — the LLM needs
						// its id to wake it later with agent_send (or stop it).
						content: [
							{
								type: "text",
								text: outcome.resident
									? `${truncateForContext(outcome.output)}${maybeWriteFullOutput(agent.agentId, outcome.output)}\n\n(agent @${agent.agentId} is resident \u2014 send it follow-ups with agent_send)`
									: truncateForContext(outcome.output) + maybeWriteFullOutput(agent.agentId, outcome.output),
							},
						],
						details: {
							task,
							sessionPath: outcome.sessionPath,
							sessionId: outcome.sessionId,
							startedAt,
							endedAt: outcome.endedAt,
							model: agent.model,
							thinking: agent.thinking,
							events: outcome.events,
							nested: subtree.nested(),
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
				// Card title needs the id: details.agentId drives titleFrom (the
				// args key is snake_case agent_id, which titleFrom does not read).
				return {
					content: [{ type: "text", text: `agent ${params.agent_id} not found or already finished.` }],
					details: { agentId, error: `agent ${params.agent_id} not found or already finished` },
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
					const message = `agent ${params.agent_id} already finished.`;
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
		description: "Send a message to another agent — a sub-agent or your parent.",
		promptSnippet: "Send a message to a sub-agent or your parent",
		promptGuidelines: [
			"Send follow-up instructions to a persistent agent with agent_send — its context is intact and it wakes to handle the message.",
			"A sub-agent blocked on missing information should agent_send @parent a concise question; the parent replies the same way.",
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
