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
 *   the child runs until it finishes or is stopped via AgentControl.
 */

import { interpretEvent } from "./event-interpret.js";
import type { RpcCommand, RpcEvent } from "./protocol.js";
import { RpcClient, type RpcClientOptions } from "./rpc-client.js";
import type { RenderEvent } from "./types.js";

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export type TerminalStatus = Exclude<AgentStatus, "queued" | "running">;

/** Latest activity for the widget excerpt line (never enters LLM context). */
export type AgentActivityKind = "thinking" | "text" | "tool";

/**
 * Latest activity for the widget excerpt line (never enters LLM context).
 * Tool calls carry structured name/args — the producer (event-interpret.ts)
 * emits the data; consumers decide how to display it (activityRow in
 * render.ts assembles the "name: args" label).
 */
export type AgentActivity =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; args: string };

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
	/** Display label — widget rows only, NOT passed as --name.
	 *  Sub-agent sessions follow pi's default naming (empty name → firstMessage). */
	sessionName?: string;
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

/** Build a "<name>: <args summary>" label for a tool call (widget excerpt). */
export class AgentProcess {
	readonly agentId: string;
	readonly title: string;
	/** Session display name ("<title>"), what the widget and session list show. */
	readonly sessionName: string | undefined;
	readonly startedAt = Date.now();

	status: AgentStatus = "queued";

	/** True when stop() was called via AgentControl (deliberate user action → no notification). */
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
		this.sessionName = options.sessionName ?? options.title;
		this.timeoutMs = options.timeoutMs;
		this.abortSettleGraceMs = options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS;
		this.onDelta = options.onDelta;
		this.onActivityChange = options.onActivityChange;

		const args: string[] = [];
		if (options.model) args.push("--model", options.model);
		if (options.thinking) args.push("--thinking", options.thinking);
		if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
		// An explicit title is a deliberate session name (pi supports renaming);
		// without one the session follows pi's default (firstMessage) like any
		// normal session — the prompt-first-line fallback is TUI display only.
		if (options.title) args.push("--name", options.title.slice(0, 80));
		if (options.sessionDir) args.push("--session-dir", options.sessionDir);

		const clientOptions: RpcClientOptions = {
			args,
			cwd: options.cwd,
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

	/** Inject a redirecting message; delivered after the current turn settles. */
	async steer(message: string): Promise<void> {
		await this.client.sendCommand({ type: "steer", message });
	}

	/** Hard-interrupt the current turn. */
	async abort(): Promise<void> {
		await this.client.sendCommand({ type: "abort" }).catch(() => {});
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
	 * Wait until the agent reaches a terminal state, applying graceful turn
	 * limits (wrap-up steer → hard abort) along the way.
	 *
	 * Every settle wait is bounded by the overall deadline: a child stuck in a
	 * hung model call would otherwise make us wait forever (issue #10, session
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

		try {
			while (this.status === "running" && !this.done) {
				const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
				const settled = await this.awaitSettled(remaining);
				if (this.done) break;
				if (!settled) {
					// Total wall-clock timeout: abort and bound the settle wait.
					this.hardAborted = true;
					await this.abortAndWait();
					break;
				}

				break; // normal completion
			}
		} finally {
			/* no timer to clear — waits are deadline-bounded */
		}

		this.done = true;
		if (this.status === "stopped") {
			// Already stopped externally (AgentControl.stop) — keep it.
		} else if (this.hardAborted) {
			this.status = "stopped";
		} else if (this.agentError) {
			this.status = "failed";
		} else if (this.client.exitCode !== null && this.client.exitCode !== 0) {
			this.status = "failed";
		} else {
			this.status = "completed";
		}

		const output = await this.lastOutput();
		const finalOutput = this.agentError && !output.trim() ? this.agentError : output;
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
	 * user-controlled (AgentControl.stop / cancel) — suppresses notifications.
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
	 * processed. Thinking and tool-call events are recorded as they arrive;
	 * text_delta events are folded into the current text event (consecutive
	 * deltas append). The stream mirrors pi's session replay order.
	 */
	getEvents(): RenderEvent[] {
		return this.events;
	}

	// ── Internal ───────────────────────────────────────────

	private readonly onDelta: ((delta: string) => void) | undefined;
	private readonly onActivityChange: ((activity: AgentActivity) => void) | undefined;
	/** "kind\u0000text" of the activity last delivered via onActivityChange. */
	private lastNotifiedActivityKey: string | undefined;

	private onEvent(event: RpcEvent): void {
		// Raw protocol shapes are interpreted in event-interpret.ts — the only
		// place pi's event vocabulary is mapped onto ours. This switch is the
		// whole policy surface: settle bookkeeping, activity dedup + push, and
		// streamed deltas.
		for (const ev of interpretEvent(event)) {
			switch (ev.type) {
				case "settled":
					this.settle();
					break;
				case "activity": {
					this.latestActivity = ev.activity;
					// Thinking/tool transitions carry no text deltas — the card would
					// never refresh without this push (text keeps streaming via onDelta).
					// Dedup key is structured, not a display label — no shared format
					// with the render layer.
					const key =
						ev.activity.kind === "tool"
							? `tool\u0000${ev.activity.name}\u0000${ev.activity.args}`
							: `${ev.activity.kind}\u0000${ev.activity.text}`;
					if (ev.activity.kind !== "text" && key !== this.lastNotifiedActivityKey) {
						this.lastNotifiedActivityKey = key;
						this.onActivityChange?.(ev.activity);
					}
					break;
				}
				case "text_delta":
					this.onDelta?.(ev.delta);
					break;
				case "agent_failed":
					this.agentError = ev.error;
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
