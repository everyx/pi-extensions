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
 * Graceful turn limits (issue #10 decision 10):
 *   After each settled turn we read get_session_stats. At the wrap-up token
 *   threshold we steer a "wrap up" message; at the hard limit (or total
 *   wall-clock timeout) we abort → wait for the next settle → stop.
 */

import * as crypto from "node:crypto";
import type { RpcEvent } from "./protocol.js";
import { RpcClient, type RpcClientOptions } from "./rpc-client.js";

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
	/** Tool allowlist (comma-joined into --tools). */
	tools?: string[];
	/** Short task title (notification card). */
	title?: string;
	/** Display label (title ?? prompt first line) — widget rows only, NOT passed as --name.
	 *  Sub-agent sessions follow pi's default naming (empty name → firstMessage). */
	sessionName?: string;
	/** Custom session storage dir (--session-dir) — keeps sub-agent sessions out of `pi -r`. */
	sessionDir?: string;
	/** Total wall-clock timeout for the whole task (incl. multi-turn). */
	timeoutMs?: number;
	/** Token threshold: at/above this, inject a "wrap up" steer. */
	wrapUpTokens?: number;
	/** Token threshold: at/above this, hard abort. */
	hardLimitTokens?: number;
	/** Streamed assistant text deltas (rpc message_update/text_delta) — for live tool-card output. */
	onDelta?: (delta: string) => void;
}

export interface AgentProcessDeps {
	/** Test seam: override client creation (defaults to a real RpcClient). */
	createClient?: (options: RpcClientOptions) => RpcClient;
}

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_WRAP_UP_TOKENS = 400_000;
export const DEFAULT_HARD_LIMIT_TOKENS = 500_000;
export const STOP_GRACE_MS = 5_000;

export const WRAP_UP_MESSAGE =
	"Please wrap up now: do not start any new work. Finish summarizing your current task and stop.";

export class AgentProcess {
	readonly agentId: string = crypto.randomUUID();
	readonly title: string | undefined;
	/** Session display name ("<title>"), what the widget and session list show. */
	readonly sessionName: string | undefined;
	readonly startedAt = Date.now();

	status: AgentStatus = "queued";

	/** True when stop() was called via AgentControl (deliberate user action → no notification). */
	stoppedByControl = false;

	private readonly client: RpcClient;
	private readonly timeoutMs: number;
	private readonly wrapUpTokens: number;
	private readonly hardLimitTokens: number;

	private settleWaiters = new Set<() => void>();
	private settled = false;
	private done = false;
	private wrappedUp = false;
	private hardAborted = false;
	/** Model API error captured from agent_end (stopReason "error"). */
	private agentError: string | null = null;

	sessionPath?: string;
	sessionId?: string;

	constructor(options: AgentProcessOptions, deps: AgentProcessDeps = {}) {
		this.title = options.title;
		this.sessionName = options.sessionName ?? options.title;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.wrapUpTokens = options.wrapUpTokens ?? DEFAULT_WRAP_UP_TOKENS;
		this.hardLimitTokens = options.hardLimitTokens ?? DEFAULT_HARD_LIMIT_TOKENS;
		this.onDelta = options.onDelta;

		const args: string[] = [];
		if (options.model) args.push("--model", options.model);
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
		const response = await this.client
			.sendCommand({ id: this.agentId, type: "prompt", message: prompt })
			.catch((err: Error) => ({
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
		const state = await this.client.sendCommand({ id: this.agentId, type: "get_state" }).catch(() => null);
		if (state?.success && state.data) {
			const data = state.data as { sessionFile?: string; sessionId?: string };
			this.sessionPath = data.sessionFile;
			this.sessionId = data.sessionId;
		}

		this.status = "running";
		return { ok: true };
	}

	/** Inject a redirecting message; delivered after the current turn settles. */
	async steer(message: string): Promise<void> {
		await this.client.sendCommand({ id: this.agentId, type: "steer", message });
	}

	/** Hard-interrupt the current turn. */
	async abort(): Promise<void> {
		await this.client.sendCommand({ id: this.agentId, type: "abort" }).catch(() => {});
	}

	/** Current final assistant text (rpc get_last_assistant_text). */
	async lastOutput(): Promise<string> {
		const response = await this.client
			.sendCommand({ id: this.agentId, type: "get_last_assistant_text" })
			.catch(() => null);
		if (response?.success && response.data) {
			const data = response.data as { text?: string | null };
			if (data.text) return data.text;
		}
		return "";
	}

	/** Best-effort token/tool stats from get_session_stats. */
	async getStats(): Promise<{ tokens: number; toolUses: number } | null> {
		const response = await this.client.sendCommand({ id: this.agentId, type: "get_session_stats" }).catch(() => null);
		if (!response?.success || !response.data) return null;
		const data = response.data as { tokens?: { total?: number }; toolCalls?: number };
		return {
			tokens: data.tokens?.total ?? 0,
			toolUses: data.toolCalls ?? 0,
		};
	}

	/**
	 * Latest session summary, if the child generated one (branch_summary from
	 * navigation, or compaction summary from auto-compaction). Best-effort:
	 * returns null when absent or on transport failure.
	 */
	async sessionSummary(): Promise<string | null> {
		const response = await this.client.sendCommand({ id: this.agentId, type: "get_entries" }).catch(() => null);
		if (!response?.success || !response.data) return null;
		const data = response.data as { entries?: Array<{ type?: string; summary?: string }> };
		const entries = data.entries;
		if (!Array.isArray(entries)) return null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.summary) {
				return entry.summary;
			}
		}
		return null;
	}

	/**
	 * Wait until the agent reaches a terminal state, applying graceful turn
	 * limits (wrap-up steer → hard abort) along the way.
	 */
	async waitForCompletion(): Promise<AgentCompletion> {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			this.hardAborted = true;
			void this.abort();
		}, this.timeoutMs);

		try {
			while (this.status === "running" && !this.done) {
				await this.awaitSettled();
				if (timedOut || this.done) break;

				const stats = await this.getStats();
				const total = stats?.tokens ?? 0;

				if (total >= this.hardLimitTokens) {
					this.hardAborted = true;
					await this.abort();
					await this.awaitSettled();
					break;
				}
				if (total >= this.wrapUpTokens && !this.wrappedUp) {
					this.wrappedUp = true;
					await this.steer(WRAP_UP_MESSAGE).catch(() => {});
					continue;
				}
				break; // normal completion
			}
		} finally {
			clearTimeout(timer);
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
	 * exit within STOP_GRACE_MS, SIGTERM as a fallback.
	 */
	async stop(): Promise<void> {
		if (this.done) {
			// Already terminal — just ensure the child is gone.
			this.client.endInput();
			return;
		}
		this.status = "stopped";
		this.stoppedByControl = true;
		this.done = true;
		this.client.endInput();
		this.settle();
		await Promise.race([this.client.waitForExit(), new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]);
		if (!this.client.isClosed) this.client.kill("SIGTERM");
	}

	// ── Internal ───────────────────────────────────────────

	private readonly onDelta: ((delta: string) => void) | undefined;

	private onEvent(event: RpcEvent): void {
		if (event.type === "agent_settled") {
			this.settle();
			return;
		}
		// Stream assistant text deltas to the tool card (foreground live output).
		if (event.type === "message_update" && this.onDelta) {
			const ae = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
			if (ae?.type === "text_delta" && typeof ae.delta === "string") {
				this.onDelta(ae.delta);
			}
			return;
		}
		// Capture model API errors: the final assistant message carries
		// stopReason "error" (rate limit, network, auth…). Without this the
		// turn settles normally and we'd report an empty success.
		if (event.type === "agent_end") {
			const messages = event.messages as
				| Array<{ role?: string; stopReason?: string; errorMessage?: unknown }>
				| undefined;
			if (Array.isArray(messages)) {
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i];
					if (m?.role === "assistant" && m.stopReason === "error") {
						this.agentError =
							typeof m.errorMessage === "string" && m.errorMessage ? m.errorMessage : "Sub-agent model API error";
						return;
					}
				}
			}
		}
	}

	private settle(): void {
		if (this.settled) return;
		this.settled = true;
		for (const waiter of this.settleWaiters) waiter();
		this.settleWaiters.clear();
	}

	private awaitSettled(): Promise<void> {
		if (this.settled || this.done) return Promise.resolve();
		return new Promise((resolve) => {
			this.settleWaiters.add(resolve);
		});
	}
}
