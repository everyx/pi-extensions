/**
 * InteractiveRunner — interactive backend.
 *
 * Spawns each sub‑agent inside a named tmux session (`pi -n`). The child
 * extension (see child.ts) reports each `agent_settled` back to this runner's
 * Unix-socket server; `waitForResult` pairs a posted result with a pending
 * execute/battle call.
 *
 * Design notes:
 *   - Tasks go to a `task-<id>.txt` file so prompt length never hits a tmux
 *     argv limit and never needs shell quoting.
 *   - A per‑session `run-<id>.sh` bundles env + `pi -n` invocation; we send
 *     tmux only the short command `sh <path>`. No nested shell quoting on the
 *     tmux send-keys side.
 *   - Battle follow‑ups are pasted via a temp file (`load-buffer -t <session>
 *     <file>`) to avoid tmux 3.x /dev/fd/0 portability issues.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { readLengthPrefixed } from "../protocol.js";
import { tmuxCmd, tmuxKill } from "./tmux.js";
import { DEFAULT_TIMEOUT_MS, type SubagentOptions, type SubagentResult } from "./types.js";

function id(len = 6): string {
	return crypto.randomBytes(len).toString("hex");
}
function safeName(base: string): string {
	return `pi-sub-${base.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
/** POSIX single‑quote, robust against embedded quotes/newlines. */
function squote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

interface PendingWaiter {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}
export interface TrackedSession {
	model: string;
}

export class InteractiveRunner {
	private readonly socketPath: string;
	private readonly pendingWaiters = new Map<string, PendingWaiter>();
	private readonly sessions = new Map<string, TrackedSession>();
	private server: net.Server | null = null;
	private serverReady: Promise<void> | null = null;

	constructor(private readonly tmpDir: string) {
		this.socketPath = path.join(tmpDir, "child.sock");
	}

	// ── Execute: spawn a new interactive sub‑agent ───────────────

	async execute(task: string, options: SubagentOptions): Promise<SubagentResult> {
		const sid = id();
		const sessionName = options.sessionName ?? safeName(sid);
		await this.ensureServer();

		await tmuxCmd(["new-session", "-d", "-s", sessionName, "-c", options.cwd]);

		const taskFile = path.join(this.tmpDir, `task-${sid}.txt`);
		fs.writeFileSync(taskFile, task, "utf8");

		const piArgs = ["pi", "-n", sessionName, "--name", `sub-${sid}`];
		if (options.model) piArgs.push("--model", options.model);
		if (options.tools) piArgs.push("--tools", options.tools.join(","));
		const piCmd = piArgs.map(squote).join(" ");

		const script = [
			"#!/bin/sh",
			"set -eu",
			`cd ${squote(options.cwd)}`,
			`export PI_SUBAGENT_PARENT_SOCKET=${squote(this.socketPath)}`,
			`export PI_SUBAGENT_SESSION_NAME=${squote(sessionName)}`,
			`task_file=${squote(taskFile)}`,
			'task="$(cat "$task_file")"',
			'rm -f "$task_file"',
			`exec ${piCmd} "$task"`,
			"",
		].join("\n");
		const runFile = path.join(this.tmpDir, `run-${sid}.sh`);
		fs.writeFileSync(runFile, script, "utf8");
		fs.chmodSync(runFile, 0o755);

		await tmuxCmd(["send-keys", "-t", sessionName, "-l", `sh ${runFile}`]);
		await tmuxCmd(["send-keys", "-t", sessionName, "Enter"]);

		try {
			const output = await this.waitForResult(sessionName, options.signal);
			this.sessions.set(sessionName, { model: options.model ?? "" });
			options.onOutput?.(output);
			return { output, sessionName };
		} catch (err) {
			await tmuxKill(sessionName);
			throw err;
		}
	}

	// ── Battle: paste a follow‑up into an existing session ────────

	async battle(sessionName: string, task: string, signal?: AbortSignal): Promise<SubagentResult> {
		const pasteFile = path.join(this.tmpDir, `paste-${id()}.txt`);
		fs.writeFileSync(pasteFile, task, "utf8");
		try {
			await tmuxCmd(["load-buffer", "-t", sessionName, pasteFile]);
			await tmuxCmd(["paste-buffer", "-t", sessionName]);
			await tmuxCmd(["send-keys", "-t", sessionName, "Enter"]);
		} finally {
			try {
				fs.unlinkSync(pasteFile);
			} catch {
				/* best effort */
			}
		}
		const output = await this.waitForResult(sessionName, signal);
		return { output, sessionName };
	}

	// ── Session lifecycle ────────────────────────────────────────

	/**
	 * Close a specific session: remove from tracking, await tmux cleanup.
	 */
	async closeSession(name: string): Promise<void> {
		this.sessions.delete(name);
		await tmuxKill(name);
	}

	/** Close the socket server (fire‑and‑forget, for process shutdown). */
	closeServer(): void {
		this.server?.close();
		this.server = null;
	}

	getSession(name: string): TrackedSession | undefined {
		return this.sessions.get(name);
	}

	activeSessionNames(): string[] {
		return [...this.sessions.keys()];
	}

	/** Kill all tracked sessions (fire‑and‑forget, for shutdown). */
	killAll(): void {
		for (const name of [...this.sessions.keys()]) void tmuxKill(name);
		this.sessions.clear();
		this.closeServer();
	}

	// ── Private: socket server + waiter pairing ──────────────────

	private ensureServer(): Promise<void> {
		if (this.server) return Promise.resolve();
		if (this.serverReady) return this.serverReady;

		this.serverReady = (async () => {
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				/* ok */
			}
			const srv = net.createServer(async (socket) => {
				try {
					const { sessionName, text } = await readLengthPrefixed(socket);
					socket.end();
					const w = this.pendingWaiters.get(sessionName);
					if (w) {
						clearTimeout(w.timer);
						this.pendingWaiters.delete(sessionName);
						w.resolve(text);
					}
				} catch {
					/* connection error or timeout — ignore */
				}
			});
			await new Promise<void>((resolve, reject) => {
				srv.on("error", reject);
				srv.listen(this.socketPath, () => resolve());
			});
			this.server = srv;
		})();
		return this.serverReady;
	}

	private waitForResult(sessionName: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Timeout waiting for ${sessionName}`));
			}, timeoutMs);

			const onAbort = () => {
				cleanup();
				reject(new Error("Aborted"));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.pendingWaiters.delete(sessionName);
				signal?.removeEventListener("abort", onAbort);
			};

			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });

			this.pendingWaiters.set(sessionName, {
				resolve: (text) => {
					cleanup();
					resolve(text);
				},
				reject: (err) => {
					cleanup();
					reject(err);
				},
				timer,
			});
		});
	}
}
