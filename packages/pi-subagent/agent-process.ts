/**
 * pi-subagent — AgentProcess.
 *
 * One resident `pi --mode rpc` child, wrapped behind Agent-tool semantics.
 * The parent extension holds N AgentProcess instances (foreground: one at a
 * time; background: several).
 *
 * Lifecycle:
 *   spawnAndSend(prompt) → running
 *   [ optional: steer(msg) / abort() while running ]
 *   waitForCompletion()  → terminal (completed / failed / stopped)
 *   stop()               → graceful stdin EOF, SIGTERM fallback
 *
 * Token limits: none. A timeoutMs (if set) triggers a hard abort → graceful
 *   settle within the grace window → hard-stop if it never settles. Otherwise
 *   the child runs until it finishes or is stopped via agent_stop.
 */

import { type AgentActivity, interpretEvent } from "./event-interpret.js";
import type { AgentMessage, RpcCommand, RpcEvent } from "./protocol.js";
import { RpcClient, type RpcClientOptions } from "./rpc-client.js";
import type { RenderEvent } from "./types.js";

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export type TerminalStatus = Exclude<AgentStatus, "queued" | "running">;

export interface AgentStats {
	tokens: number;
	toolUses: number;
	durationMs: number;
}

export interface AgentCompletion {
	status: TerminalStatus;
	output: string;
	stats: AgentStats;
	sessionPath?: string;
	sessionId?: string;
}

export interface AgentProcessOptions {
	cwd: string;
	/** Resolved "provider/id" model string, or inherit when omitted. */
	model?: string;
	/** Reasoning intensity ("off"…"max"), passed as --thinking. */
	thinking?: string;
	/** Tool allowlist (comma-joined into --tools). */
	tools?: string[];
	/** Short task title (notification card). */
	title: string;
	/** Sequential short id ("a1", "a2", …) assigned by the registry. */
	agentId: string;
	/** Custom session storage dir (--session-dir) — keeps sub-agent sessions out of `pi -r`. */
	sessionDir?: string;
	/** Total wall-clock timeout for the whole task (incl. multi-turn).
	 *  Omitted = no limit (the default): the child runs until it finishes,
	 *  is stopped, or hits an explicit token limit. */
	timeoutMs?: number;
	/** After an abort, how long to wait for the child to settle before hard-stopping it. */
	abortSettleGraceMs?: number;
	/** Streamed assistant text deltas (rpc message_update/text_delta) — for live tool-card output. */
	onDelta?: (delta: string) => void;
	/** Thinking/tool activity transitions (no text delta involved) — for live tool-card rows. */
	onActivityChange?: (activity: AgentActivity) => void;
	/** In-tree message received from this child (extension_ui_request under the reserved key). */
	onMessage?: (message: AgentMessage) => void;
	/** A woken persistent agent settled back to idle (widget row flip). */
	onIdle?: () => void;
	/** Resident after completion (idle, zero token) — explicit opt-in, default off. */
	persistent?: boolean;
	/** Extra child environment (identity injection: PI_SUBAGENT_AGENT_ID / PI_SUBAGENT_PARENT). */
	env?: NodeJS.ProcessEnv;
}

export interface AgentProcessDeps {
	/** Test seam: override client creation (defaults to a real RpcClient). */
	createClient?: (options: RpcClientOptions) => RpcClient;
}

export const DEFAULT_ABORT_SETTLE_GRACE_MS = 30_000;
export const STOP_GRACE_MS = 5_000;

// The only task-level limit is the opt-in timeoutMs: the Agent tool passes
// it when the caller wants a bound — the default is no limit (a Pi extension
// should not impose hidden deadlines on sub-agents).

export class AgentProcess {
	readonly agentId: string;
	readonly title: string;
	readonly startedAt = Date.now();
	readonly model: string | undefined;
	readonly thinking: string | undefined;
	/** Resident after completion (idle, zero token) — explicit opt-in. */
	readonly persistent: boolean;

	status: AgentStatus = "queued";

	/** True when stop() was called via agent_stop (deliberate user action → no notification). */
	stoppedByControl = false;

	private readonly client: RpcClient;
	private readonly timeoutMs: number | undefined;
	private readonly abortSettleGraceMs: number;

	private settleWaiters = new Set<() => void>();
	/** Total agent_settled events seen; lets awaitSettled skip settles that
	 *  arrived while no waiter was attached (synchronous test emit pattern). */
	private settleCount = 0;
	/** settleCount observed at the last awaitSettled() call. */
	private lastSettledCount = 0;
	private done = false;
	private hardAborted = false;
	/** Model API error captured from agent_end (stopReason "error"). */
	private agentError: string | null = null;
	/** Latest activity excerpt for the widget. */
	private latestActivity: AgentActivity | null = null;
	/** Ordered activity stream — accumulated from RPC events at the source. */
	private events: RenderEvent[] = [];

	sessionPath?: string;
	sessionId?: string;

	constructor(options: AgentProcessOptions, deps: AgentProcessDeps = {}) {
		this.agentId = options.agentId;
		this.title = options.title;
		this.timeoutMs = options.timeoutMs;
		this.abortSettleGraceMs = options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS;
		this.model = options.model;
		this.thinking = options.thinking;
		this.persistent = options.persistent ?? false;
		this.onDelta = options.onDelta;
		this.onActivityChange = options.onActivityChange;
		this.onMessage = options.onMessage;
		this.onIdle = options.onIdle;

		const args: string[] = [];
		if (options.model) args.push("--model", options.model);
		if (options.thinking) args.push("--thinking", options.thinking);
		if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
		// The (required) title names the session (pi supports renaming).
		args.push("--name", options.title.slice(0, 80));
		if (options.sessionDir) args.push("--session-dir", options.sessionDir);

		const clientOptions: RpcClientOptions = {
			args,
			cwd: options.cwd,
			env: options.env,
			onEvent: (event) => this.onEvent(event),
			onExit: () => {
				// Process died (any reason): release everyone waiting on settle.
				this.settle();
				this.done = true;
			},
		};
		this.client = deps.createClient ? deps.createClient(clientOptions) : new RpcClient(clientOptions);
	}

	// ── Public API ─────────────────────────────────────────

	/** Spawn + send the prompt; resolves once the prompt preflight succeeded. */
	async spawnAndSend(prompt: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const response = await this.client.sendCommand({ type: "prompt", message: prompt }).catch((err: Error) => ({
			type: "response" as const,
			command: "prompt",
			success: false as const,
			error: err.message,
		}));

		if (!response.success) {
			this.status = "failed";
			return { ok: false, error: response.error };
		}

		// Best-effort session info for the notification / attach (issue #10).
		const data = await this.sendData<{ sessionFile?: string; sessionId?: string }>({ type: "get_state" });
		if (data) {
			this.sessionPath = data.sessionFile;
			this.sessionId = data.sessionId;
		}

		this.status = "running";
		return { ok: true };
	}

	/** Hard-interrupt the current turn. */
	async abort(): Promise<void> {
		await this.client.sendCommand({ type: "abort" }).catch(() => {});
	}

	/**
	 * Deliver one in-tree message to this agent (parent→child): a prompt
	 * with streamingBehavior "steer" — idle starts a new turn (wake), a
	 * running child queues it (delivered after the turn). Resolves whether
	 * the prompt preflight accepted the message. Waking an idle persistent
	 * agent flips it back to running.
	 */
	async sendMessage(text: string): Promise<boolean> {
		const response = await this.client
			.sendCommand({ type: "prompt", message: text, streamingBehavior: "steer" })
			.catch((err: Error) => ({
				type: "response" as const,
				command: "prompt" as const,
				success: false as const,
				error: err.message,
			}));
		if (!response.success) return false;
		// Woke an idle persistent agent — activity resumes.
		if (this.status === "completed" || this.status === "failed") this.status = "running";
		return true;
	}

	/** Current final assistant text (rpc get_last_assistant_text). */
	async lastOutput(): Promise<string> {
		const data = await this.sendData<{ text?: string | null }>({ type: "get_last_assistant_text" });
		return data?.text ?? "";
	}

	/** Best-effort token/tool stats from get_session_stats. */
	async getStats(): Promise<{ tokens: number; toolUses: number } | null> {
		const data = await this.sendData<{ tokens?: { total?: number }; toolCalls?: number }>({
			type: "get_session_stats",
		});
		if (!data) return null;
		return {
			tokens: data.tokens?.total ?? 0,
			toolUses: data.toolCalls ?? 0,
		};
	}

	/** sendCommand → typed response payload (null on failure/timeout/empty). */
	private async sendData<T>(command: RpcCommand): Promise<T | null> {
		const response = await this.client.sendCommand(command).catch(() => null);
		if (!response?.success || !response.data) return null;
		return response.data as T;
	}

	/**
	 * Wait until the agent reaches a terminal state.
	 *
	 * The wait is bounded by the overall deadline: a child stuck in a hung
	 * model call would otherwise make us wait forever (issue #10, session
	 * 019fc63c: sub-agent completed but never settled; only a user interrupt
	 * released the wait). On deadline we abort, give the child a grace window
	 * to settle, then hard-stop it.
	 */
	async waitForCompletion(): Promise<AgentCompletion> {
		// No deadline when timeoutMs is omitted — the child runs until it
		// settles, is stopped, or hits an explicit token limit. `deadline` stays
		// undefined so `remaining` is undefined and awaitSettled waits forever
		// (its own `timeoutMs !== undefined` guard skips the timer).
		const deadline = this.timeoutMs === undefined ? undefined : Date.now() + this.timeoutMs;

		// Wait for the first settle to resolve, the child to exit (onExit flips
		// `done`), or the deadline. A deadline with neither is outright stuck:
		// abort and give the child a bound to settle, hard-stopping if it can't.
		if (this.status === "running" && !this.done) {
			const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
			const settled = await this.awaitSettled(remaining);
			if (!this.done && !settled) {
				this.hardAborted = true;
				await this.abortAndWait();
			}
		}

		this.done = true;
		if (this.status === "stopped") {
			// Already stopped externally (agent_stop) — keep it.
		} else if (this.hardAborted) {
			this.status = "stopped";
		} else if (this.agentError) {
			this.status = "failed";
		} else if (this.client.exitCode !== null && this.client.exitCode !== 0) {
			this.status = "failed";
		} else {
			this.status = "completed";
		}

		// A failed child usually leaves empty terminal text; the real root cause
		// lives in the model error (agentError) or the stderr the RpcClient
		// captured before exit — surface it instead of a blank "Sub-agent failed."
		const output = await this.lastOutput();
		const finalOutput =
			this.agentError && !output.trim()
				? this.agentError
				: this.status === "failed" && !output.trim()
					? this.client.stderrText
					: output;
		const stats = await this.getStats();
		return {
			status: this.status,
			output: finalOutput,
			stats: {
				tokens: stats?.tokens ?? 0,
				toolUses: stats?.toolUses ?? 0,
				durationMs: Date.now() - this.startedAt,
			},
			sessionPath: this.sessionPath,
			sessionId: this.sessionId,
		};
	}

	/**
	 * Graceful stop: stdin EOF → pi rpc shutdown(). If the child doesn't
	 * exit within STOP_GRACE_MS, SIGTERM as a fallback. Flags the stop as
	 * user-controlled (agent_stop / cancel) — suppresses notifications.
	 */
	async stop(): Promise<void> {
		if (this.done) {
			// Already terminal — just ensure the child is gone.
			this.client.endInput();
			return;
		}
		this.stoppedByControl = true;
		await this.hardStop();
	}

	/** stdin EOF + SIGTERM fallback; waits for the child to exit. */
	private async hardStop(): Promise<void> {
		this.status = "stopped";
		this.done = true;
		this.client.endInput();
		this.settle();
		await Promise.race([this.client.waitForExit(), new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]);
		if (!this.client.isClosed) this.client.kill("SIGTERM");
	}

	/** Latest activity excerpt for the widget (null until the first message_update). */
	getLatestActivity(): AgentActivity | null {
		return this.latestActivity;
	}

	/**
	 * Ordered activity stream accumulated from every RPC event this agent
	 * processed. Thinking and tool-call activity are recorded as they arrive;
	 * text_delta events are folded into the current text event (consecutive
	 * deltas append). The stream mirrors pi's session replay order.
	 */
	getEvents(): RenderEvent[] {
		return this.events;
	}

	// ── Internal ───────────────────────────────────────────

	private readonly onDelta: ((delta: string) => void) | undefined;
	private readonly onActivityChange: ((activity: AgentActivity) => void) | undefined;
	private readonly onMessage: ((message: AgentMessage) => void) | undefined;
	private readonly onIdle: (() => void) | undefined;

	private onEvent(event: RpcEvent): void {
		// Raw protocol shapes are interpreted in event-interpret.ts — the only
		// place pi's event vocabulary is mapped onto ours. Since v0.84.0 the
		// wire carries only assistantMessageEvent deltas, so each event maps to
		// a discrete marker here: the policy surface is settle bookkeeping,
		// thinking/tool activity push, streamed text folding, and in-tree
		// message delivery.
		for (const ev of interpretEvent(event)) {
			switch (ev.type) {
				case "settled":
					this.settle();
					// Persistent agent woke by sendMessage finished its turn —
					// back to idle (completed) so the widget shows it as such.
					if (this.done && this.persistent && this.status === "running") {
						this.status = "completed";
						this.onIdle?.();
					}
					break;
				case "thinking":
					// Collapse consecutive thinking deltas into one marker.
					if (this.events[this.events.length - 1]?.kind !== "thinking") {
						this.events.push({ kind: "thinking" });
						const activity: AgentActivity = { kind: "thinking", text: "" };
						this.latestActivity = activity;
						this.onActivityChange?.(activity);
					}
					break;
				case "tool_call": {
					// toolcall_end is the authoritative tool call: the wire streams
					// the name on toolcall_start and the arguments on toolcall_delta,
					// but only the end event carries the complete call, so the earlier
					// events are deliberately ignored. The row stays visible while the
					// tool actually executes, mirroring the pre-v0.84 card.
					this.events.push(ev.activity);
					this.latestActivity = ev.activity;
					this.onActivityChange?.(ev.activity);
					break;
				}
				case "text_delta": {
					// Fold consecutive text deltas into the current text event.
					const last = this.events[this.events.length - 1];
					if (last?.kind === "text") {
						last.text += ev.delta;
					} else {
						this.events.push({ kind: "text", text: ev.delta });
					}
					// Widget excerpt reflects the latest streamed text.
					this.latestActivity = { kind: "text", text: last?.kind === "text" ? last.text : ev.delta };
					this.onDelta?.(ev.delta);
					break;
				}
				case "agent_failed":
					this.agentError = ev.error;
					break;
				case "agent_msg":
					this.onMessage?.(ev.message);
					break;
			}
		}
	}

	private settle(): void {
		// Count-based: agent_settled fires when the child's run loop finishes —
		// a steer re-runs the loop and settles again, so each post-steer/
		// post-abort turn must be awaited (no one-shot latch). The count also
		// survives settles that arrive while no waiter is attached.
		this.settleCount++;
		for (const waiter of this.settleWaiters) waiter();
		this.settleWaiters.clear();
	}

	/**
	 * Resolve true on the next settle, or false after timeoutMs (no timeout
	 * when omitted). The waiter is removed from the set on either path so a
	 * late settle can't double-resolve.
	 */
	private awaitSettled(timeoutMs?: number): Promise<boolean> {
		if (this.done) return Promise.resolve(true);
		// A settle arrived since our last wait — pass through immediately.
		if (this.settleCount > this.lastSettledCount) {
			this.lastSettledCount = this.settleCount;
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const onSettle = () => {
				if (timer) clearTimeout(timer);
				this.settleWaiters.delete(onSettle);
				this.lastSettledCount = this.settleCount;
				resolve(true);
			};
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					this.settleWaiters.delete(onSettle);
					resolve(false);
				}, timeoutMs);
			}
			this.settleWaiters.add(onSettle);
		});
	}

	/**
	 * Abort the child and wait (bounded) for its settle. An abort can be
	 * ineffective when the child is stuck — hung model call, wedged run loop:
	 * if no settle arrives within the grace window, hard-stop the child (stdin
	 * EOF + SIGTERM fallback) so waitForCompletion can never hang forever.
	 */
	private async abortAndWait(): Promise<void> {
		await this.abort().catch(() => {});
		const settled = await this.awaitSettled(this.abortSettleGraceMs);
		if (!settled && !this.done && this.client.exitCode === null) {
			// Timeout/limit escalation, NOT a user-controlled stop — hard-stop
			// without flagging stoppedByControl so background notifications still fire.
			await this.hardStop();
		}
	}
}
