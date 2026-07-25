/**
 * pi-subagent – Spawn sub‑agent pi instances via tmux.
 *
 * Two‑mode extension:
 *   Parent mode (default) – registers the `subagent` tool
 *   Child  mode (env var) – reports results back on `agent_settled`
 *
 * Execution backends live in ./runner.ts behind the SubagentRunner seam.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { keyHint, type Theme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activateChildMode, PrintRunner, TmuxRunner } from "./runner.js";

// ─── Temp dir (created at module init, cleaned up on shutdown) ─

let _tmpDir: string | null = null;
function getTmpDir(): string {
	if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	return _tmpDir;
}

// ─── Runner instances (singletons) ────────────────────────────

const printRunner = new PrintRunner();
const tmuxRunner = new TmuxRunner(getTmpDir());

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

/** Start a live timer that calls `tick()` every `interval` ms. Returns a stop function. */
function startTimer(tick: () => void, interval = 100): () => void {
	const id = setInterval(tick, interval);
	return () => clearInterval(id);
}

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
		activateChildMode(pi, parentSocket, process.env.PI_SUBAGENT_SESSION_NAME ?? "");
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
			// Validate mutually exclusive parameters
			const hasTasks = !!(params.tasks && params.tasks.length > 0);
			const hasSession = !!params.session;
			const hasClose = !!params.close;
			const hasTask = !!params.task;
			const activeModeCount = [hasTasks, hasSession && hasTask, hasSession && hasClose].filter(Boolean).length;

			if (activeModeCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: "Ambiguous parameters: `tasks[]`, `session + task` (battle), and `session + close` are mutually exclusive.",
						},
					],
					details: {},
					isError: true,
				};
			}
			if (hasSession && !hasTask && !hasClose) {
				return {
					content: [{ type: "text", text: "`session` requires either `task` (battle) or `close: true`." }],
					details: {},
					isError: true,
				};
			}

			// ── Close ──────────────────────────────────
			if (params.close && params.session) {
				const s = tmuxRunner.getSession(params.session);
				if (!s) {
					return {
						content: [
							{
								type: "text",
								text: `Session "${params.session}" not found.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				tmuxRunner.killSession(params.session);
				return {
					content: [{ type: "text", text: `Closed sub‑agent session ${params.session}` }],
					details: {},
				};
			}

			// ── Battle ──────────────────────────────────
			if (params.session && params.task) {
				const s = tmuxRunner.getSession(params.session);
				if (!s) {
					return {
						content: [
							{
								type: "text",
								text: `Session "${params.session}" not found.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const startedAt = Date.now();

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

				const stop = startTimer(() =>
					onUpdate?.({
						content: [{ type: "text", text: tasksToLlmXml([taskDisplay]) }],
						details: { tasks: [taskDisplay] },
					}),
				);

				try {
					const result = await tmuxRunner.battle(params.session, params.task, signal);
					const endedAt = Date.now();

					taskDisplay.output = result.output;
					taskDisplay.model = s.model;
					taskDisplay.done = true;
					taskDisplay.endedAt = endedAt;

					return {
						content: [{ type: "text", text: tasksToLlmXml([taskDisplay]) }],
						details: { tasks: [taskDisplay] },
					};
				} finally {
					stop();
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
				const taskCount = params.tasks.length;
				onUpdate?.({
					content: [],
					details: { header: `(0/${taskCount})`, tasks: [...taskDisplays] },
				});

				await Promise.all(
					params.tasks.map(async (t, i) => {
						const resolved = tryResolveModel(ctx.modelRegistry, ctx.model, t.model);
						const model = resolved.model;
						const interactive = t.interactive ?? false;

						taskDisplays[i].model = resolved.model ?? "";
						taskDisplays[i].warning = resolved.warning;
						taskDisplays[i].startedAt = Date.now();

						const runner = interactive ? tmuxRunner : printRunner;

						const stop = startTimer(() => {
							const doneCount = taskDisplays.filter((t) => t.done).length;
							onUpdate?.({
								content: [{ type: "text", text: tasksToLlmXml([...taskDisplays]) }],
								details: { header: `(${doneCount}/${taskCount})`, tasks: [...taskDisplays] },
							});
						});
						try {
							const result = await runner.execute(t.task, {
								cwd: ctx.cwd,
								model,
								tools: t.tools,
								signal,
								onChunk: (chunk) => {
									taskDisplays[i].output = chunk;
								},
							});

							taskDisplays[i].output = result.output;
							taskDisplays[i].sessionName = result.sessionName;
							taskDisplays[i].done = true;
							taskDisplays[i].endedAt = Date.now();

							// Track session for battle / cleanup (runner already registered it)
							// Session tracking is handled inside TmuxRunner.execute() on success.

							// Yield to event loop so TUI can render partial state
							await new Promise((resolve) => setTimeout(resolve, 10));

							// Send accumulated results so far
							onUpdate?.({
								content: [{ type: "text", text: tasksToLlmXml([...taskDisplays]) }],
								details: {
									header: `(${taskDisplays.filter((t) => t.done).length}/${taskCount})`,
									tasks: [...taskDisplays],
								},
							});
						} finally {
							stop();
						}
					}),
				);

				return {
					content: [{ type: "text", text: tasksToLlmXml(taskDisplays) }],
					details: {
						header: `(${taskDisplays.length}/${taskDisplays.length})`,
						tasks: taskDisplays,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Provide `tasks[]`, `session` + `task` (battle), or `session` + `close`.",
					},
				],
				details: {},
				isError: true,
			};
		},

		// ── Rendering ───────────────────────────────
		renderCall(args, theme, _ctx) {
			if (args.tasks && args.tasks.length > 0) {
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

			if (state.startedAt === undefined && isPartial) {
				state.startedAt = Date.now();
			}
			if (!isPartial && state.startedAt !== undefined) {
				state.endedAt ??= Date.now();
			}

			const details = result.details as Record<string, unknown> | undefined;
			const tasks = details?.tasks as TaskDisplay[] | undefined;
			if (tasks) {
				const cmp: Container = (ctx.lastComponent as Container | undefined) ?? new Container();
				cmp.clear();

				if (details?.header) {
					cmp.addChild(
						new Text(
							`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", details.header as string)}`,
							0,
							0,
						),
					);
					cmp.addChild(new Spacer(1));
				}

				for (let i = 0; i < tasks.length; i++) {
					renderTaskItem(cmp, tasks[i], isPartial, expanded, theme);
				}

				if (state.startedAt !== undefined) {
					const label = isPartial ? "Elapsed" : "Took";
					const endTime = state.endedAt ?? Date.now();
					const dur = ((endTime - state.startedAt) / 1000).toFixed(1);
					cmp.addChild(new Text(`\n${theme.fg("muted", `${label} ${dur}s`)}`, 0, 0));
				}

				return cmp;
			}

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

		const names = tmuxRunner.activeSessionNames();

		if (names.length > 0) {
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Sub‑agents still running",
					`${names.length} active: ${names.join(", ")}
Close them?`,
				);
				if (!ok) return;
			}

			tmuxRunner.killAll();
		} else {
			// No active sessions, just close the server
			tmuxRunner.close();
		}

		// Remove temp dir
		if (_tmpDir) {
			try {
				fs.rmSync(_tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});
}
