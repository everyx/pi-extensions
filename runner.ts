/**
 * pi-subagent — Sub‑agent execution backends.
 *
 * Defines the Runner seam and two adapters:
 *   PrintRunner → `pi --print --no-session` (non‑interactive)
 *   TmuxRunner  → tmux + socket + `pi -n` (interactive, attachable)
 */

import { execSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Result & options types ─────────────────────────────────

export interface SubagentResult {
	output: string;
	/** Only set for interactive (tmux) mode — used for battle & close. */
	sessionName?: string;
}

export interface SubagentOptions {
	cwd: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	/**
	 * Stream progress updates.
	 * - PrintRunner: called on each `text_delta`
	 * - TmuxRunner: called once when result arrives
	 */
	onChunk?: (output: string) => void;
}

export interface SubagentRunner {
	execute(task: string, options: SubagentOptions): Promise<SubagentResult>;
}

// ─── Utility ─────────────────────────────────────────────────

function id(len = 6): string {
	return crypto.randomBytes(len).toString("hex");
}

function safeName(base: string): string {
	return `pi-sub-${base.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

type ContentPart = { type: string; text?: string };

function lastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			const parts = (e.message.content ?? [])
				.filter((c: ContentPart) => c.type === "text")
				.map((c: ContentPart) => c.text);
			const text = parts.join("\n").trim();
			if (text) return text;
		}
	}
	return "";
}

// ─── Socket protocol — length‑prefixed framing ────────────────

export interface PrefixedParse {
	sessionName: string;
	text: string;
}

export function readLengthPrefixed(socket: net.Socket, signal?: AbortSignal): Promise<PrefixedParse> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);

		const onAbort = () => {
			cleanup();
			reject(new Error("Aborted"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Timeout reading from socket"));
		}, 10_000);

		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length < 4) return;
			const len = buf.readUInt32BE(0);
			if (buf.length < 4 + len) return;

			cleanup();

			const payload = buf.subarray(4, 4 + len);
			const nullIdx = payload.indexOf(0);
			const sessionName = nullIdx >= 0 ? payload.subarray(0, nullIdx).toString("utf8") : "";
			const text = nullIdx >= 0 ? payload.subarray(nullIdx + 1).toString("utf8") : payload.toString("utf8");

			resolve({ sessionName, text });
		};

		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};

		const onClose = () => {
			cleanup();
			reject(new Error("Socket closed before full message"));
		};

		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
			socket.removeListener("close", onClose);
			socket.removeListener("end", onClose);
		};

		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("close", onClose);
		socket.on("end", onClose);
	});
}

/**
 * Write one length‑prefixed message to a socket.
 *
 * Protocol: `[4B big‑endian payload length][payload]`.
 * Payload is `sessionName\0text` (sessionName may be empty).
 */
export function writeLengthPrefixed(socket: net.Socket, sessionName: string, text: string): Promise<void> {
	const combined = sessionName ? `${sessionName}\0${text}` : text;
	const payload = Buffer.from(combined, "utf8");
	const hdr = Buffer.alloc(4);
	hdr.writeUInt32BE(payload.length);

	return new Promise((resolve, reject) => {
		socket.write(Buffer.concat([hdr, payload]), (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

// ─── Interactive session state ───────────────────────────────

interface PendingWaiter {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

// ─── tmux helpers ────────────────────────────────────────────

function tmuxKill(name: string): void {
	try {
		execSync(`tmux kill-session -t "${name}"`, { stdio: "ignore" });
	} catch {
		/* already dead */
	}
}

// ═══════════════════════════════════════════════════════════════
//  PrintRunner — non‑interactive (pi --print --no-session)
// ═══════════════════════════════════════════════════════════════

export class PrintRunner implements SubagentRunner {
	async execute(task: string, options: SubagentOptions): Promise<SubagentResult> {
		return new Promise((resolve, reject) => {
			const args = ["--mode", "json", "-p", "--no-session"];
			if (options.model) args.push("--model", options.model);
			if (options.tools) args.push("--tools", options.tools.join(","));
			args.push(task);

			const proc = spawn("pi", args, {
				cwd: options.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stderr = "";
			let accumulatedText = "";

			function processLine(line: string) {
				if (!line.trim()) return;
				let evt: Record<string, unknown>;
				try {
					evt = JSON.parse(line);
				} catch {
					return;
				}
				if (evt.type === "agent_settled") return;
				if (evt.type === "message_update") {
					const ae = evt.assistantMessageEvent as Record<string, unknown> | undefined;
					if (ae?.type === "text_delta" && typeof ae.delta === "string") {
						accumulatedText += ae.delta;
						options.onChunk?.(accumulatedText);
					}
					return;
				}
				if (evt.type === "agent_end") {
					const msgs = evt.messages as Array<Record<string, unknown>> | undefined;
					if (msgs) {
						for (let i = msgs.length - 1; i >= 0; i--) {
							const msg = msgs[i];
							if (msg?.role === "assistant") {
								const parts = (msg.content as Array<Record<string, unknown>> | undefined) ?? [];
								const text = parts
									.filter((c) => c.type === "text")
									.map((c) => c.text as string)
									.join("\n")
									.trim();
								if (text) {
									accumulatedText = text;
									options.onChunk?.(accumulatedText);
								}
								break;
							}
						}
					}
					return;
				}
			}

			let leftover = "";
			proc.stdout.on("data", (d: Buffer) => {
				const chunk = d.toString();
				const parts = (leftover + chunk).split("\n");
				leftover = parts.pop() ?? "";
				for (const line of parts) {
					processLine(line);
				}
			});
			proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

			const timeout = setTimeout(() => {
				proc.kill("SIGTERM");
				reject(new Error("Sub‑agent timed out"));
			}, 600_000);
			const abort = () => {
				clearTimeout(timeout);
				proc.kill("SIGTERM");
			};
			if (options.signal?.aborted) {
				abort();
				reject(new Error("Aborted"));
				return;
			}
			options.signal?.addEventListener("abort", abort, { once: true });

			proc.on("close", (code) => {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", abort);
				if (leftover) processLine(leftover);
				if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
				else resolve({ output: accumulatedText || "(no output)" });
			});
			proc.on("error", reject);
		});
	}
}

// ═══════════════════════════════════════════════════════════════
//  TmuxRunner — interactive (tmux + socket)
// ═══════════════════════════════════════════════════════════════

export class TmuxRunner implements SubagentRunner {
	private socketPath: string;
	private pendingWaiters = new Map<string, PendingWaiter>();
	private server: net.Server | null = null;
	private serverReady: Promise<void> | null = null;
	private sessions = new Map<string, { model: string }>();

	constructor(private tmpDir: string) {
		this.socketPath = path.join(tmpDir, "child.sock");
	}

	/** Create a new interactive sub‑agent session. */
	async execute(task: string, options: SubagentOptions): Promise<SubagentResult> {
		const sid = id();
		const sessionName = safeName(sid);

		await this.ensureServer();

		// Start tmux session
		execSync(`tmux new-session -d -s "${sessionName}" -c "${options.cwd}"`, { stdio: "ignore" });

		// Shell‑safe quoting
		const squote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

		const piArgs = ["pi", "-n", sessionName, "--name", `sub-${sid}`];
		if (options.model) piArgs.push("--model", options.model);
		if (options.tools) piArgs.push("--tools", options.tools.join(","));
		piArgs.push(squote(task));

		const script = [
			"#!/bin/sh",
			`export PI_SUBAGENT_PARENT_SOCKET='${this.socketPath}'`,
			`export PI_SUBAGENT_SESSION_NAME='${sessionName}'`,
			`cd ${squote(options.cwd)}`,
			`exec ${piArgs.join(" ")}`,
		].join("\n");

		this.tmuxRun(sessionName, script);

		try {
			const output = await this.waitForResult(sessionName, options.signal);
			options.onChunk?.(output);
			this.registerSession(sessionName, options.model ?? "");
			return { output, sessionName };
		} catch (err) {
			tmuxKill(sessionName);
			throw err;
		}
	}

	/**
	 * Battle mode — send a follow‑up prompt to an existing session.
	 * The session must have been created by a prior `execute()` call.
	 */
	async battle(sessionName: string, task: string, signal?: AbortSignal): Promise<SubagentResult> {
		this.tmuxPaste(sessionName, task);
		const output = await this.waitForResult(sessionName, signal);
		return { output, sessionName };
	}

	/** Close the shared socket server. No‑op if not running. */
	close(): void {
		if (this.server) {
			this.server.close();
		}
	}

	/** Kill a tmux session by name. Removes from internal tracking. No‑op if already dead. */
	killSession(name: string): void {
		tmuxKill(name);
		this.sessions.delete(name);
	}

	/** Register an interactive session for battle / cleanup tracking. */
	registerSession(name: string, model: string): void {
		this.sessions.set(name, { model });
	}

	/** Look up a session (for battle / close validation). */
	getSession(name: string): { model: string } | undefined {
		return this.sessions.get(name);
	}

	/** List active session names (for shutdown confirm dialog). */
	activeSessionNames(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Kill all tracked sessions and close the socket server.
	 * Non‑interactive (PrintRunner) children are OS child processes —
	 * they receive SIGHUP when the parent exits, no tracking needed.
	 */
	killAll(): void {
		for (const name of this.sessions.keys()) {
			tmuxKill(name);
		}
		this.sessions.clear();
		this.close();
	}

	// ── Private ──────────────────────────────────

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

					const w = this.pendingWaiters.get(sessionName);
					if (w) {
						clearTimeout(w.timer);
						this.pendingWaiters.delete(sessionName);
						w.resolve(text);
					}
					socket.end();
				} catch {
					/* connection error or timeout – ignore */
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

	private waitForResult(sessionName: string, signal?: AbortSignal, timeoutMs = 600_000): Promise<string> {
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
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });

			this.pendingWaiters.set(sessionName, {
				resolve: (text: string) => {
					cleanup();
					resolve(text);
				},
				reject: (err: Error) => {
					cleanup();
					reject(err);
				},
				timer,
			});
		});
	}

	private tmuxRun(name: string, script: string): void {
		const tmp = path.join(this.tmpDir, `run-${id(4)}.sh`);
		fs.writeFileSync(tmp, script, "utf8");
		fs.chmodSync(tmp, 0o755);
		execSync(`tmux send-keys -t "${name}" -l "sh ${tmp}"`, { stdio: "ignore" });
		execSync(`tmux send-keys -t "${name}" Enter`, { stdio: "ignore" });
	}

	private tmuxPaste(name: string, text: string): void {
		const tmp = path.join(this.tmpDir, `paste-${id(4)}.txt`);
		fs.writeFileSync(tmp, text, "utf8");
		execSync(`tmux load-buffer -t "${name}" "${tmp}"`, { stdio: "ignore" });
		execSync(`tmux paste-buffer -t "${name}"`, { stdio: "ignore" });
		execSync(`tmux send-keys -t "${name}" Enter`, { stdio: "ignore" });
	}
}

// ─── Child mode entry ─────────────────────────────────────────

/**
 * Activate child mode: report results back to the parent via Unix socket.
 *
 * Called from the extension's default export when the env var
 * `PI_SUBAGENT_PARENT_SOCKET` is set.
 */
export function activateChildMode(pi: ExtensionAPI, socketEnv: string, sessionName: string): void {
	pi.on("agent_settled", async (_event, ctx) => {
		const text = lastAssistantText(ctx);
		if (!text) return;

		try {
			const socket = net.createConnection(socketEnv);
			await new Promise<void>((resolve, reject) => {
				socket.on("connect", resolve);
				socket.on("error", reject);
			});
			await writeLengthPrefixed(socket, sessionName, text);
			socket.end();
		} catch {
			/* best effort */
		}
	});
}
