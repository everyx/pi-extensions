/**
 * pi-subagent – Spawn sub‑agent pi instances via tmux.
 *
 * Two‑mode extension:
 *   Parent mode (default) – registers the `subagent` tool
 *   Child  mode (env var) – reports results back on `agent_settled`
 *
 * Non‑interactive → `pi --print --no-session`
 * Interactive     → tmux + full pi + unix socket
 * Battle          → tmux send‑keys + socket (interactive sessions only)
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ─── Common ──────────────────────────────────────────────────────

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));

function id(len = 6): string {
	return crypto.randomBytes(len).toString("hex");
}

function safeName(base: string): string {
	return `pi-sub-${base.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// ─── tmux helpers ────────────────────────────────────────────────

function tmuxNew(name: string, cwd: string): void {
	execSync(`tmux new-session -d -s "${name}" -c "${cwd}"`, { stdio: "ignore" });
}

/**
 * Paste literal text into a tmux pane.
 * Uses tmux load‑buffer + paste‑buffer so newlines and special chars are handled correctly.
 */
function tmuxPaste(name: string, text: string): void {
	const tmp = path.join(TMPDIR, `paste-${id(4)}.txt`);
	fs.writeFileSync(tmp, text, "utf8");
	execSync(`tmux load-buffer -t "${name}" "${tmp}"`, { stdio: "ignore" });
	execSync(`tmux paste-buffer -t "${name}"`, { stdio: "ignore" });
	execSync(`tmux send-keys -t "${name}" Enter`, { stdio: "ignore" });
}

/**
 * Run a shell script inside the tmux session.
 * The script is written to a temp file and executed via `sh`.
 */
function tmuxRun(name: string, script: string): void {
	const tmp = path.join(TMPDIR, `run-${id(4)}.sh`);
	fs.writeFileSync(tmp, script, "utf8");
	fs.chmodSync(tmp, 0o755);
	execSync(`tmux send-keys -t "${name}" -l "sh ${tmp}"`, { stdio: "ignore" });
	execSync(`tmux send-keys -t "${name}" Enter`, { stdio: "ignore" });
}

function tmuxKill(name: string): void {
	try {
		execSync(`tmux kill-session -t "${name}"`, { stdio: "ignore" });
	} catch {
		/* already dead */
	}
}

// ─── Unix socket – length‑prefixed framing ───────────────────────

function createServer(socketPath: string): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		try { fs.unlinkSync(socketPath); } catch { /* ok */ }
		const srv = net.createServer();
		srv.on("error", reject);
		srv.listen(socketPath, () => resolve(srv));
	});
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		try { server.close(() => resolve()); } catch { resolve(); }
	});
}

/** Wait for child to connect and send exactly one length‑prefixed message. */
function readOnce(
	server: net.Server,
	signal?: AbortSignal,
	timeoutMs = 600_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
		const clean = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			try { server.close(); } catch { /* ok */ }
		};
		const onAbort = () => { clean(); reject(new Error("Aborted")); };
		if (signal?.aborted) { onAbort(); return; }
		signal?.addEventListener("abort", onAbort, { once: true });

		server.on("connection", (socket) => {
			let buf = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				if (buf.length < 4) return;
				const len = buf.readUInt32BE(0);
				if (buf.length < 4 + len) return;
				clean();
				resolve(buf.slice(4, 4 + len).toString("utf8"));
			});
			socket.on("error", reject);
			socket.on("end", () => {
				if (!buf.length) { clean(); reject(new Error("Connection closed empty")); }
			});
		});
	});
}

// ─── Non‑interactive: pi --print ────────────────────────────────

function printRun(
	task: string,
	cwd: string,
	model?: string,
	tools?: string,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = ["--print", "--no-session"];
		if (model) args.push("--model", model);
		if (tools) args.push("--tools", tools);
		// spawn() does not go through shell → no quoting issues
		args.push(task);

		const proc = spawn("pi", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

		const timeout = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("Sub‑agent timed out")); }, 600_000);
		const abort = () => { clearTimeout(timeout); proc.kill("SIGTERM"); };
		if (signal?.aborted) { abort(); reject(new Error("Aborted")); return; }
		signal?.addEventListener("abort", abort, { once: true });

		proc.on("close", (code) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
			else resolve(stdout.trim());
		});
		proc.on("error", reject);
	});
}

// ─── Extract last assistant text from a session ─────────────────

function lastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			const parts = (e.message.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text);
			const text = parts.join("\n").trim();
			if (text) return text;
		}
	}
	return "";
}

// ─── Active session state ────────────────────────────────────────

interface SessionState {
	id: string;
	sessionName: string;
	socketPath: string;
	server: net.Server;
}

const sessions = new Map<string, SessionState>();

// ─── Run a single interactive (tmux) sub‑agent ───────────────────

async function runInteractive(
	cwd: string,
	task: string,
	model?: string,
	tools?: string,
	signal?: AbortSignal,
): Promise<{ output: string; sessionName: string }> {
	const sid = id();
	const sessionName = safeName(sid);
	const sp = path.join(TMPDIR, `${sessionName}.sock`);

	const server = await createServer(sp);

	// Start tmux session
	tmuxNew(sessionName, cwd);

	// Shell‑safe quoting: wrap in single quotes, escape inner single quotes with '\''
	const squote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

	const piArgs = ["pi", "-n", sessionName, "--name", `sub-${sid}`];
	if (model) piArgs.push("--model", model);
	if (tools) piArgs.push("--tools", tools);
	piArgs.push(squote(task));

	const script = [
		"#!/bin/sh",
		`export PI_SUBAGENT_PARENT_SOCKET='${sp}'`,
		`cd ${squote(cwd)}`,
		`exec ${piArgs.join(" ")}`,
	].join("\n");

	tmuxRun(sessionName, script);

	// Wait for the child to settle and send its result
	const output = await readOnce(server, signal);

	// Track session for battle / cleanup
	sessions.set(sessionName, { id: sid, sessionName, socketPath: sp, server });

	return { output, sessionName };
}

// ─── Tool parameters ─────────────────────────────────────────────

const TaskConfig = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional identifier" })),
	task: Type.String({ description: "Task prompt for the sub‑agent" }),
	model: Type.Optional(Type.String({ description: "Model override" })),
	tools: Type.Optional(Type.String({ description: "Tool allowlist (comma‑separated)" })),
});

const SubagentParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Single task" })),
	tasks: Type.Optional(Type.Array(TaskConfig, { description: "Parallel tasks" })),
	session: Type.Optional(Type.String({ description: "Continue existing session (battle)" })),
	close: Type.Optional(Type.Boolean({ description: "Close a session" })),
	model: Type.Optional(Type.String({ description: "Model for single mode" })),
	tools: Type.Optional(Type.String({ description: "Tools for single mode" })),
	interactive: Type.Optional(
		Type.Boolean({ description: "Spawn in tmux (attachable)", default: false }),
	),
});

// ─── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Child mode ────────────────────────────────────────
	const parentSocket = process.env.PI_SUBAGENT_PARENT_SOCKET;
	if (parentSocket) {
		pi.on("agent_settled", async (_event, ctx) => {
			const text = lastAssistantText(ctx);
			if (!text) return;

			try {
				const socket = net.createConnection(parentSocket);
				await new Promise<void>((resolve, reject) => {
					socket.on("connect", resolve);
					socket.on("error", reject);
				});
				const buf = Buffer.from(text, "utf8");
				const hdr = Buffer.alloc(4);
				hdr.writeUInt32BE(buf.length);
				socket.write(Buffer.concat([hdr, buf]));
				socket.end();
			} catch {
				/* best effort */
			}
		});
		return; // Don't register the tool in child mode
	}

	// ── Parent mode ──────────────────────────────────────
	pi.registerTool({
		name: "subagent",
		label: "Sub‑agent",
		description:
			"Delegate a task to a sub‑agent with an isolated context window. " +
			"Non‑interactive (default): spawns pi --print and captures stdout. " +
			"Interactive (interactive:true): spawns inside tmux so you can tmux attach -t <name>. " +
			"Battle: set session to an existing interactive session name and the task becomes a follow‑up prompt. " +
			"Parallel: use tasks[] to run multiple sub‑agents.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// ── Close ──────────────────────────────────
			if (params.close && params.session) {
				const s = sessions.get(params.session);
				if (s) {
					tmuxKill(s.sessionName);
					try { s.server.close(); } catch { /* ok */ }
					sessions.delete(params.session);
				}
				return {
					content: [{ type: "text", text: `Closed sub‑agent session ${params.session}` }],
					details: {},
				};
			}

			// ── Battle ──────────────────────────────────
			if (params.session && params.task) {
				const s = sessions.get(params.session);
				if (!s) {
					return {
						content: [{
							type: "text",
							text: `Session "${params.session}" not found. Active: ${Array.from(sessions.keys()).join(", ") || "none"}`,
						}],
						details: {},
						isError: true,
					};
				}

				// Close old server, then create a new one for this round
				await closeServer(s.server);
				s.server = await createServer(s.socketPath);

				// Type the follow‑up prompt into the running pi editor
				tmuxPaste(s.sessionName, params.task);

				const output = await readOnce(s.server, signal);
				return {
					content: [{ type: "text", text: output }],
					details: { session: params.session },
				};
			}

			// ── Parallel ────────────────────────────────
			if (params.tasks && params.tasks.length > 0) {
				const interactive = params.interactive ?? false;
				const dets = await Promise.all(
					params.tasks.map(async (t) => {
						if (interactive) {
							const r = await runInteractive(ctx.cwd, t.task, t.model, t.tools, signal);
							return { id: t.id ?? t.task.slice(0, 40), output: r.output, sessionName: r.sessionName };
						}
						const out = await printRun(t.task, ctx.cwd, t.model, t.tools, signal);
						return { id: t.id ?? t.task.slice(0, 40), output: out };
					}),
				);
				const body = dets.map((d) => `## ${d.id}\n\n${d.output}`).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text: body }],
					details: { sessions: dets.filter((d) => d.sessionName).map((d) => d.sessionName) },
				};
			}

			// ── Single ──────────────────────────────────
			if (!params.task) {
				return {
					content: [{ type: "text", text: "Provide `task`, `tasks[]`, or `session` + `task`." }],
					details: {},
					isError: true,
				};
			}

			if (params.interactive) {
				const r = await runInteractive(ctx.cwd, params.task, params.model, params.tools, signal);
				return {
					content: [{ type: "text", text: r.output }],
					details: { session: r.sessionName },
				};
			}

			const out = await printRun(params.task, ctx.cwd, params.model, params.tools, signal);
			return {
				content: [{ type: "text", text: out }],
				details: {},
			};
		},

		// ── Rendering ───────────────────────────────
		renderCall(args, theme, _ctx) {
			if (args.tasks && args.tasks.length > 0) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `parallel (${args.tasks.length}) `) +
						theme.fg("muted", args.interactive ? "[tmux]" : "[print]"),
					0, 0,
				);
			}
			if (args.session) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", "battle ") +
						theme.fg("dim", args.session),
					0, 0,
				);
			}
			if (args.close) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("muted", "close ") +
						theme.fg("dim", args.session ?? ""),
					0, 0,
				);
			}
			const preview = args.task?.length > 50 ? args.task.slice(0, 50) + "…" : args.task ?? "…";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("muted", args.interactive ? "[tmux] " : "[print] ") +
					theme.fg("dim", preview),
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme, _ctx) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!text) return new Text(theme.fg("muted", "(no output)"), 0, 0);

			const details = result.details as Record<string, unknown> | undefined;
			if (details?.session) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", details.session as string) +
						"\n" +
						theme.fg("toolOutput", text.slice(0, expanded ? undefined : 500)),
					0, 0,
				);
			}
			return new Text(
				theme.fg("toolOutput", text.slice(0, expanded ? undefined : 1000)),
				0, 0,
			);
		},
	});

	// ── Cleanup on exit ───────────────────────────────
	pi.on("session_shutdown", async (event, ctx) => {
		// Clean up temp dir when parent quits
		if (event.reason === "quit") {
			try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* ok */ }
		}

		if (event.reason !== "quit") return;
		if (sessions.size === 0) return;

		const names = Array.from(sessions.keys());

		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Sub‑agents still running",
				`${names.length} active: ${names.join(", ")}\nClose them?`,
			);
			if (!ok) return;
		}

		for (const s of sessions.values()) {
			tmuxKill(s.sessionName);
			await closeServer(s.server);
		}
		sessions.clear();
	});
}
