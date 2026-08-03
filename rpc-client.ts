/**
 * pi-subagent — thin stateful RPC client.
 *
 * Spawns a `pi --mode rpc` child and speaks the JSONL protocol over
 * stdin/stdout. This class owns only transport concerns:
 *   - spawn + argv wiring
 *   - stdin writer (commands) / stdout reader (responses + events)
 *   - pending request map correlated by command id
 *   - stderr capture
 *   - exit handling (rejects all pending on unexpected exit)
 *
 * It is deliberately NOT the framework's RpcClient: that one is private,
 * bets on a 100ms setTimeout for readiness, and SIGTERM→SIGKILLs on stop.
 * We only need a small, honest subset of the protocol.
 *
 * Stateful (spawns a real process) → not unit tested; see protocol.ts for
 * the tested pure layer and agent-process.ts for the testable semantics.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseLine, type RpcCommand, type RpcEvent, type RpcResponse, serializeCommand } from "./protocol.js";

export interface RpcClientOptions {
	/** pi argv after `--mode rpc` (e.g. --model, --tools, --name). */
	args: string[];
	cwd: string;
	/** Test seam: executable to spawn (default "pi"). When set, `args` are used verbatim (no --mode rpc). */
	command?: string;
	onEvent?: (event: RpcEvent) => void;
	onStderr?: (text: string) => void;
	/** Called once when the child exits (any reason). */
	onExit?: () => void;
}

/** How long to wait for a single command response before failing it. */
const RESPONSE_TIMEOUT_MS = 10_000;

interface PendingWaiter {
	resolve: (response: RpcResponse) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

export class RpcClient {
	private readonly proc: ChildProcess;
	private readonly options: RpcClientOptions;
	private readonly pending = new Map<string, PendingWaiter>();
	private readonly decoder = new StringDecoder("utf8");
	private seq = 0;
	private buffer = "";
	private stderr = "";
	private closed = false;
	private exitPromise: Promise<{ code: number | null; signal: string | null }>;
	private resolveExit!: (value: { code: number | null; signal: string | null }) => void;

	constructor(options: RpcClientOptions) {
		this.options = options;
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});

		const argv = options.command === undefined ? ["--mode", "rpc", ...options.args] : options.args;
		const proc = spawn(options.command ?? "pi", argv, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;

		// Raw Buffer chunks: StringDecoder buffers partial multibyte sequences
		// across chunk boundaries — toString("utf8") first would corrupt them
		// (U+FFFD) and make the decoder pointless.
		proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
			options.onStderr?.(chunk.toString());
		});
		// Stream errors (e.g. write-after-end during shutdown races) must never
		// crash the host as unhandled 'error' events — fail pending commands.
		proc.stdin.on("error", (err) => this.failAll(err));
		proc.on("error", (err) => this.failAll(err));
		proc.on("close", (code, signal) => {
			this.closed = true;
			this.failAll(new Error(this.stderr.trim() || `pi exited (code ${code})`));
			options.onExit?.();
			this.resolveExit({ code, signal });
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get exitCode(): number | null {
		return this.proc.exitCode;
	}

	/** Resolves when the child process has exited. */
	waitForExit(): Promise<{ code: number | null; signal: string | null }> {
		return this.exitPromise;
	}

	/** Send one command and await its correlated response. */
	sendCommand(command: RpcCommand): Promise<RpcResponse> {
		// Unique per-command id: the pending map is keyed by id and the child
		// echoes it back — a shared id (e.g. the agent id) would let a later
		// command steal an earlier waiter and mismatch responses.
		const cmd = { ...command, id: `c${++this.seq}` };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(cmd.id);
				reject(new Error(`RPC timeout waiting for "${command.type}" response`));
			}, RESPONSE_TIMEOUT_MS);

			this.pending.set(cmd.id, { resolve, reject, timer });
			const stdin = this.proc.stdin;
			// Guard against shutdown races: a command written after endInput()
			// would throw ERR_STREAM_WRITE_AFTER_END (unhandled 'error' crash).
			if (!stdin || stdin.writableEnded || stdin.destroyed) {
				clearTimeout(timer);
				this.pending.delete(cmd.id);
				reject(new Error(`RPC stdin closed (cannot send "${command.type}")`));
				return;
			}
			stdin.write(serializeCommand(cmd), (err) => {
				if (!err) return;
				clearTimeout(timer);
				this.pending.delete(cmd.id);
				reject(err);
			});
		});
	}

	/** Graceful shutdown: stdin EOF triggers pi's rpc-mode `shutdown()`. */
	endInput(): void {
		if (!this.proc.stdin || this.proc.stdin.destroyed) return;
		this.proc.stdin.end();
	}

	/** Hard fallback: signal the child. */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.closed || this.proc.exitCode !== null) return;
		try {
			this.proc.kill(signal);
		} catch {
			/* already dead */
		}
	}

	// ── stdout line framing (strict LF, mirrors pi's jsonl.js) ──

	private onData(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		const parsed = parseLine(line);
		if (!parsed) return;

		if (parsed.kind === "response") {
			const { id } = parsed.response;
			if (!id) return;
			const waiter = this.pending.get(id);
			if (!waiter) return;
			clearTimeout(waiter.timer);
			this.pending.delete(id);
			waiter.resolve(parsed.response);
			return;
		}

		this.options.onEvent?.(parsed.event);
	}

	private failAll(err: Error): void {
		for (const [id, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			this.pending.delete(id);
			waiter.reject(err);
		}
	}
}
