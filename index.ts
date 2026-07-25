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

import { execSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { keyHint, type Theme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Task display type ──────────────────────────────────────────

interface TaskDisplay {
	id: string;
	output: string;
	sessionName?: string;
	prompt: string;
	model: string;
	done: boolean;
	startedAt?: number;
	endedAt?: number;
	warning?: string;
}

// ─── Expandable output helper ──────────────────────────────────

function renderExpandableOutput(styledOutput: string, theme: Theme, w: number, indent = 0): string[] {
	const preview = truncateToVisualLines(styledOutput, 5, w, indent);

	if (preview.skippedCount > 0) {
		const hint =
			theme.fg("muted", `... (${preview.skippedCount} earlier lines, `) +
			keyHint("app.tools.expand", "to expand") +
			theme.fg("muted", ")");
		// Use Text paddingX for indentation
		const hintLine = new Text(hint, indent, 0).render(w)[0];
		return [hintLine, ...preview.visualLines];
	}
	return preview.visualLines;
}

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

// ─── Shared Unix socket – length‑prefixed framing ────────────────

const SHARED_SOCKET_PATH = path.join(TMPDIR, "child.sock");

export interface PrefixedParse {
	sessionName: string;
	text: string;
}

/**
 * Read one length‑prefixed message from a socket.
 *
 * Protocol: `[4B big‑endian payload length][payload]`.
 * Payload is `sessionName\0text` (sessionName may be empty).
 */
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

/**
 * Pending result waiters, keyed by session name.
 * A child connects, sends `[4B len][sessionName\0text]`, and the router
 * dispatches to the matching waiter.
 */
const pendingWaiters = new Map<
	string,
	{ resolve: (text: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();

/* Lazy singleton – created on first interactive use */
let sharedServer: net.Server | null = null;
let serverReady: Promise<net.Server> | null = null;

function ensureSharedServer(): Promise<net.Server> {
	if (sharedServer) return Promise.resolve(sharedServer);
	if (serverReady) return serverReady;

	serverReady = (async () => {
		try {
			fs.unlinkSync(SHARED_SOCKET_PATH);
		} catch {
			/* ok */
		}

		const srv = net.createServer(async (socket) => {
			try {
				const { sessionName, text } = await readLengthPrefixed(socket);

				const w = pendingWaiters.get(sessionName);
				if (w) {
					clearTimeout(w.timer);
					pendingWaiters.delete(sessionName);
					w.resolve(text);
				}
				socket.end();
			} catch {
				/* connection error or timeout – ignore */
			}
		});

		await new Promise<void>((resolve, reject) => {
			srv.on("error", reject);
			srv.listen(SHARED_SOCKET_PATH, () => resolve());
		});

		sharedServer = srv;
		return srv;
	})();

	return serverReady;
}

/** Wait for a result message from a specific interactive sub‑agent. */
function waitForResult(sessionName: string, signal?: AbortSignal, timeoutMs = 600_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingWaiters.delete(sessionName);
			reject(new Error(`Timeout waiting for ${sessionName}`));
		}, timeoutMs);

		const onAbort = () => {
			clearTimeout(timer);
			pendingWaiters.delete(sessionName);
			reject(new Error("Aborted"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		pendingWaiters.set(sessionName, { resolve, reject, timer });
	});
}

// ─── Model resolution ──────────────────────────────────────────

function resolveModel(registry: ModelRegistry, model?: string): string | undefined {
	if (!model) return undefined;

	const available = registry.getAvailable();
	if (available.length === 0) return undefined;

	const normalize = (s: string) => s.toLowerCase().replace(/[._:]+/g, "-");

	// Try to parse provider/model — prefer /, fallback to : or .
	const sepIdx = model.includes("/")
		? model.indexOf("/")
		: model.includes(":")
			? model.indexOf(":")
			: model.includes(".")
				? model.indexOf(".")
				: -1;

	const providerHint = sepIdx >= 0 ? model.slice(0, sepIdx) : undefined;
	const modelName = sepIdx >= 0 ? model.slice(sepIdx + 1) : model;
	const normModel = normalize(modelName);

	const matches = (m: { provider: string; id: string }) =>
		normalize(`${m.provider}/${m.id}`).includes(normModel) || normalize(m.id).includes(normModel);

	// If provider hint given, try that provider first
	if (providerHint) {
		const normProvider = normalize(providerHint);
		for (const m of available) {
			if (normalize(m.provider).includes(normProvider) && matches(m)) {
				return `${m.provider}/${m.id}`;
			}
		}
	}

	// Search all available models
	for (const m of available) {
		if (matches(m)) return `${m.provider}/${m.id}`;
	}

	return undefined;
}

interface ResolvedModel {
	model: string | undefined;
	warning?: string;
}

function tryResolveModel(
	registry: ModelRegistry,
	fallback: { provider: string; id: string } | undefined | null,
	originalModel?: string,
): ResolvedModel {
	const fallbackModel = fallback ? `${fallback.provider}/${fallback.id}` : undefined;
	// No model override → pass parent session model directly, no registry lookup
	if (!originalModel) return { model: fallbackModel };
	const resolved = resolveModel(registry, originalModel);
	if (resolved) return { model: resolved };
	// User passed a model but it wasn't found
	return {
		model: fallbackModel,
		warning: `Model "${originalModel}" not available, using "${fallbackModel ?? "default"}"`,
	};
}

// ─── Non‑interactive: pi --print ────────────────────────────────

function printRun(
	task: string,
	cwd: string,
	model?: string,
	tools?: string,
	signal?: AbortSignal,
	onChunk?: (chunk: string) => void,
): Promise<string> {
	return new Promise((resolve, reject) => {
		// Use --mode json for line-delimited streaming events
		const args = ["--mode", "json", "-p", "--no-session"];
		if (model) args.push("--model", model);
		if (tools) args.push("--tools", tools);
		args.push(task);

		const proc = spawn("pi", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		let accumulatedText = "";

		// Process a single JSON event line
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
					onChunk?.(accumulatedText);
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
								onChunk?.(accumulatedText);
							}
							break;
						}
					}
				}
				return;
			}
		}

		// Buffer lines from stdout and process one by one
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
		if (signal?.aborted) {
			abort();
			reject(new Error("Aborted"));
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });

		proc.on("close", (code) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (leftover) processLine(leftover);
			if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
			else resolve(accumulatedText || "(no output)");
		});
		proc.on("error", reject);
	});
}

type ContentPart = { type: string; text?: string };

// ─── Extract last assistant text from a session ─────────────────

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

// ─── Active session state ────────────────────────────────────────

interface SessionState {
	id: string;
	sessionName: string;
	model: string;
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

	// Ensure the shared socket server is running
	await ensureSharedServer();

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
		`export PI_SUBAGENT_PARENT_SOCKET='${SHARED_SOCKET_PATH}'`,
		`export PI_SUBAGENT_SESSION_NAME='${sessionName}'`,
		`cd ${squote(cwd)}`,
		`exec ${piArgs.join(" ")}`,
	].join("\n");

	tmuxRun(sessionName, script);

	// Wait for the child to settle and send its result
	const output = await waitForResult(sessionName, signal);

	// Track session for battle / cleanup
	sessions.set(sessionName, { id: sid, sessionName, model: model ?? "" });

	return { output, sessionName };
}

// ─── Tool parameters ─────────────────────────────────────────────

const TaskConfig = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional identifier" })),
	task: Type.String({ description: "Task prompt for the sub‑agent" }),
	model: Type.Optional(Type.String({ description: "Model override" })),
	tools: Type.Optional(Type.String({ description: "Tool allowlist (comma‑separated)" })),
	interactive: Type.Optional(Type.Boolean({ description: "Spawn in tmux (attachable)", default: false })),
});

const SubagentParams = Type.Object({
	tasks: Type.Optional(
		Type.Array(TaskConfig, {
			description:
				"One or more sub‑agents to run. " +
				"Pass a single entry for one task, " +
				"multiple entries for parallel execution. " +
				"Each entry can set interactive, model, tools per‑task.",
		}),
	),
	task: Type.Optional(
		Type.String({
			description: "Follow‑up prompt for battle mode (requires `session`).",
		}),
	),
	session: Type.Optional(Type.String({ description: "Continue existing session (battle)" })),
	close: Type.Optional(Type.Boolean({ description: "Close a session" })),
});

// ─── Rendering helpers ──────────────────────────────────────────

/**
 * Render a single task item: status line + collapsible body.
 * Shared between tasks/parallel and battle modes.
 */
function renderTaskItem(cmp: Container, t: TaskDisplay, isPartial: boolean, expanded: boolean, theme: Theme): void {
	const isInteractive = !!t.sessionName;
	const emoji = isInteractive ? "💬" : "⚡";

	// Status
	let statusColor: "success" | "accent" | "muted";
	let checkChar: string;
	if (t.done) {
		statusColor = "success";
		checkChar = "[✓]";
	} else if (isPartial) {
		statusColor = "accent";
		checkChar = "[~]";
	} else {
		statusColor = "muted";
		checkChar = "[ ]";
	}

	// Model tag (dim)
	const modelTag = t.model ? theme.fg("dim", `(${t.model})`) : "";

	// Session tag (dim, with | separator)
	const sessionTag = t.sessionName ? theme.fg("dim", `| ${t.sessionName}`) : "";

	// Timing tag (dim, with | separator)
	let timingTag = "";
	if (t.startedAt) {
		const endTime = t.endedAt ?? Date.now();
		const dur = ((endTime - t.startedAt) / 1000).toFixed(1);
		timingTag = theme.fg("dim", `| ⏱️ ${dur}s`);
	}

	// Assemble status line: - [✓] ⚡ task (model) [| session] [| ⏱️ x.xs]
	const statusLine = [
		`${theme.fg(statusColor, `- ${checkChar}`)} ${theme.fg(statusColor, emoji)} ${theme.fg(statusColor, t.id)}`,
		modelTag,
		sessionTag,
		timingTag,
	]
		.filter(Boolean)
		.join(" ");

	cmp.addChild(new Text(statusLine, 0, 0));

	// Body: warning + prompt (with >) + output
	if (t.warning || t.prompt || t.output) {
		const lines: string[] = [];
		if (t.warning) {
			lines.push(theme.fg("warning", t.warning));
		}
		if (t.prompt) {
			const promptDisplay = (t.prompt.length > 78 ? `${t.prompt.slice(0, 78)}...` : t.prompt).replace(/\n/g, " ");
			lines.push(theme.fg("dim", `> ${promptDisplay}`));
		}
		if (t.output) {
			const cleaned = t.output.replace(/\n+$/, "");
			const outputLines = cleaned.split("\n").map((line) => theme.fg("dim", line));
			lines.push(...outputLines);
		}
		const combined = lines.join("\n");
		const indent = 2; // aligns with [ of - [✓]
		if (expanded) {
			cmp.addChild(new Text(combined, indent, 0));
		} else {
			cmp.addChild({
				invalidate: () => {},
				render: (w: number) => renderExpandableOutput(combined, theme, w, indent),
			});
		}
	}
}

/** Serialize task results as XML for LLM consumption.
 *
 * XML is chosen over markdown code blocks because the output may itself
 * contain triple backticks. XML tags provide unambiguous boundaries.
 * Token-economy: only task id and output — no checkmarks, emoji, timing,
 * or original prompt. Those decorations are for TUI only.
 */
function tasksToLlmXml(tasks: TaskDisplay[]): string {
	return tasks.map((v) => `<result id="${escapeXml(v.id)}">\n${escapeXml(v.output)}\n</result>`).join("\n");
}

/** Minimal XML escaping — only what's needed for element content safety. */
function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function (pi: ExtensionAPI) {
	// ── Child mode ────────────────────────────────────────
	const parentSocket = process.env.PI_SUBAGENT_PARENT_SOCKET;
	if (parentSocket) {
		const childSessionName = process.env.PI_SUBAGENT_SESSION_NAME ?? "";

		pi.on("agent_settled", async (_event, ctx) => {
			const text = lastAssistantText(ctx);
			if (!text) return;

			try {
				const socket = net.createConnection(parentSocket);
				await new Promise<void>((resolve, reject) => {
					socket.on("connect", resolve);
					socket.on("error", reject);
				});
				await writeLengthPrefixed(socket, childSessionName, text);
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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// ── Close ──────────────────────────────────
			if (params.close && params.session) {
				const s = sessions.get(params.session);
				if (s) {
					tmuxKill(s.sessionName);
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
						content: [
							{
								type: "text",
								text: `Session "${params.session}" not found. Active: ${Array.from(sessions.keys()).join(", ") || "none"}`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const startedAt = Date.now();

				// Show task in-progress immediately
				const taskDisplay: TaskDisplay = {
					id: params.task.slice(0, 40),
					output: "",
					prompt: params.task,
					model: s.model,
					sessionName: params.session,
					done: false,
					startedAt,
				};
				onUpdate?.({
					content: [],
					details: { tasks: [taskDisplay] },
				});

				// Live timer: refresh every second
				const timer = setInterval(
					() =>
						onUpdate?.({
							content: [],
							details: { tasks: [{ ...taskDisplay }] },
						}),
					100,
				);
				const stopTimer = () => clearInterval(timer);

				try {
					tmuxPaste(s.sessionName, params.task);
					const output = await waitForResult(s.sessionName, signal);
					const endedAt = Date.now();

					taskDisplay.output = output;
					taskDisplay.model = s.model;
					taskDisplay.done = true;
					taskDisplay.endedAt = endedAt;

					return {
						content: [{ type: "text", text: tasksToLlmXml([taskDisplay]) }],
						details: { tasks: [taskDisplay] },
					};
				} finally {
					stopTimer();
				}
			}

			// ── Tasks (single or parallel) ─────────────────
			if (params.tasks && params.tasks.length > 0) {
				const taskDisplays: TaskDisplay[] = params.tasks.map((t) => ({
					id: t.id ?? t.task.slice(0, 40),
					output: "",
					prompt: t.task,
					model: t.model ?? "",
					done: false,
				}));

				// Toast: show all tasks in pending state (header + tasks atomically)
				const header = `subagent (0/${params.tasks.length})`;
				onUpdate?.({ content: [], details: { header, tasks: [...taskDisplays] } });

				await Promise.all(
					params.tasks.map(async (t, i) => {
						const resolved = tryResolveModel(ctx.modelRegistry, ctx.model, t.model);
						const model = resolved.model;
						const interactive = t.interactive ?? false;

						taskDisplays[i].model = resolved.model ?? "";
						taskDisplays[i].warning = resolved.warning;
						taskDisplays[i].startedAt = Date.now();

						// Live timer: refresh every second
						const timer = setInterval(
							() =>
								onUpdate?.({
									content: [{ type: "text", text: tasksToLlmXml([...taskDisplays]) }],
									details: { header, tasks: [...taskDisplays] },
								}),
							100,
						);
						const stopTimer = () => clearInterval(timer);
						const tick = stopTimer;

						try {
							let output: string;
							let sessionName: string | undefined;

							if (interactive) {
								const r = await runInteractive(ctx.cwd, t.task, model, t.tools, signal);
								output = r.output;
								sessionName = r.sessionName;
							} else {
								output = await printRun(t.task, ctx.cwd, model, t.tools, signal, (chunk) => {
									taskDisplays[i].output = chunk;
									tick();
								});
							}

							taskDisplays[i].output = output;
							taskDisplays[i].sessionName = sessionName;
							taskDisplays[i].done = true;
							taskDisplays[i].endedAt = Date.now();

							// Yield to event loop so TUI can render partial state
							await new Promise((resolve) => setTimeout(resolve, 10));

							// Send accumulated results so far
							return tick();
						} finally {
							stopTimer();
						}
					}),
				);

				return {
					content: [{ type: "text", text: tasksToLlmXml(taskDisplays) }],
					details: {
						header,
						tasks: taskDisplays,
						type: "parallel",
						sessions: taskDisplays.filter((d) => d.sessionName).map((d) => d.sessionName as string),
					},
				};
			}

			return {
				content: [{ type: "text", text: "Provide `tasks[]`, `session` + `task` (battle), or `session` + `close`." }],
				details: {},
				isError: true,
			};
		},

		// ── Rendering ───────────────────────────────
		renderCall(args, theme, _ctx) {
			if (args.tasks && args.tasks.length > 0) {
				// Header is rendered inside renderResult alongside task items,
				// so they appear atomically — no visual gap.
				return new Text("", 0, 0);
			}
			if (args.session && args.task) {
				return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("dim", args.session)}`, 0, 0);
			}
			if (args.close) {
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", "\u2715 close")} ${theme.fg("dim", args.session ?? "")}`,
					0,
					0,
				);
			}
			return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const state = ctx.state as { startedAt?: number; endedAt?: number };

			// Track overall timing
			if (state.startedAt === undefined && isPartial) {
				state.startedAt = Date.now();
			}
			if (!isPartial && state.startedAt !== undefined) {
				state.endedAt ??= Date.now();
			}

			const details = result.details as Record<string, unknown> | undefined;
			// ── Task list (tasks/parallel + battle both use this) ──
			const tasks = details?.tasks as TaskDisplay[] | undefined;
			if (tasks) {
				const cmp: Container = (ctx.lastComponent as Container | undefined) ?? new Container();
				cmp.clear();

				// Render header if provided (tasks mode)
				if (details?.header) {
					cmp.addChild(
						new Text(
							`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", details.header as string)}`,
							0,
							0,
						),
					);
				}

				for (let i = 0; i < tasks.length; i++) {
					const isLast = i === tasks.length - 1;
					renderTaskItem(cmp, tasks[i], isPartial, expanded, theme);
					if (!isLast) {
						cmp.addChild(new Spacer(1));
					}
				}

				// Overall duration
				if (state.startedAt !== undefined) {
					const label = isPartial ? "Elapsed" : "Took";
					const endTime = state.endedAt ?? Date.now();
					const dur = ((endTime - state.startedAt) / 1000).toFixed(1);
					cmp.addChild(new Text(`\n${theme.fg("muted", `${label} ${dur}s`)}`, 0, 0));
				}

				return cmp;
			}

			// ── Fallback (close mode, errors, etc.) ──
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!text && !isPartial) {
				return new Text("", 0, 0);
			}
			return new Text(theme.fg("dim", text), 0, 0);
		},
	});

	// ── Cleanup on exit ───────────────────────────────
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;

		// Kill active sessions and close server first
		if (sessions.size > 0) {
			const names = Array.from(sessions.keys());

			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Sub‑agents still running",
					`${names.length} active: ${names.join(", ")}
Close them?`,
				);
				if (!ok) return;
			}

			for (const s of sessions.values()) {
				tmuxKill(s.sessionName);
			}
			sessions.clear();

			// Close shared server
			if (sharedServer) {
				try {
					sharedServer.close();
				} catch {
					/* ok */
				}
				sharedServer = null;
				serverReady = null;
			}
		}

		// Then clean up temp dir
		try {
			fs.rmSync(TMPDIR, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	});
}
