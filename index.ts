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
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activateChildMode, PrintRunner, type SubagentResult, TmuxRunner } from "./runner.js";

// ─── Temp dir (created at module init, cleaned up on shutdown) ─

let _tmpDir: string | null = null;
function getTmpDir(): string {
	if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	return _tmpDir;
}

// ─── Runner instances (singletons) ────────────────────────────

const printRunner = new PrintRunner();
const tmuxRunner = new TmuxRunner(getTmpDir());

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
	const sepIdx = model.indexOf("/");

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

const SubagentParams = Type.Object({
	task: Type.Optional(
		Type.String({
			description:
				"Task prompt for the sub‑agent. " +
				"Provide `task` alone for a single execution, " +
				"or `session` + `task` for battle mode.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model override (e.g. claude-sonnet-4 or provider/name)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist" })),
	interactive: Type.Optional(
		Type.Boolean({ description: "Spawn in tmux (attachable). Default: false (non‑interactive)", default: false }),
	),
	session: Type.Optional(Type.String({ description: "Existing interactive session name for battle or close" })),
	close: Type.Optional(Type.Boolean({ description: "Close an interactive session (requires `session`)" })),
});

// ─── Error helper ────────────────────────────────────────────────

function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface SubagentDetails {
	task: string;
	model: string;
	sessionName?: string;
	startedAt: number;
	endedAt?: number;
	warning?: string;
}

function sessionNotFoundError(sessionName: string) {
	return {
		content: [{ type: "text" as const, text: `Session "${sessionName}" not found.` }],
		details: {} as const,
		isError: true as const,
	};
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
			"Battle: set session to an existing interactive session name and the task becomes a follow‑up prompt.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Validate mutually exclusive parameters
			const hasSession = !!params.session;
			const hasClose = !!params.close;
			const hasTask = !!params.task;
			const activeModeCount = [hasTask, hasSession && hasTask, hasSession && hasClose].filter(Boolean).length;

			if (activeModeCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: "Ambiguous parameters: `task`, `session + task` (battle), and `session + close` are mutually exclusive.",
						},
					],
					details: {},
					isError: true,
				};
			}
			if (!hasTask && !hasClose) {
				return {
					content: [
						{ type: "text", text: "Provide `task` (execute), `session` + `task` (battle), or `session` + `close`." },
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
				if (!s) return sessionNotFoundError(params.session);
				tmuxRunner.killSession(params.session);
				return {
					content: [{ type: "text", text: `Closed sub‑agent session ${params.session}` }],
					details: {},
				};
			}

			// ── Single task ────────────────────────────
			if (params.task && !params.session) {
				const resolved = tryResolveModel(ctx.modelRegistry, ctx.model, params.model);
				const model = resolved.model ?? "";
				const interactive = params.interactive ?? false;
				const runner = interactive ? tmuxRunner : printRunner;
				const startedAt = Date.now();

				onUpdate?.({
					content: [],
					details: { task: params.task, model, startedAt, warning: resolved.warning },
				});

				let result: SubagentResult | undefined;
				try {
					result = await runner.execute(params.task, {
						cwd: ctx.cwd,
						model,
						tools: params.tools,
						signal,
						onChunk: () => {},
					});
				} catch (err) {
					const message = toErrorMessage(err);
					return {
						content: [{ type: "text", text: message }],
						details: { task: params.task, model, startedAt, endedAt: Date.now() },
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: result.output }],
					details: {
						task: params.task,
						model,
						sessionName: result.sessionName,
						startedAt,
						endedAt: Date.now(),
						warning: resolved.warning,
					},
				};
			}

			// ── Battle ──────────────────────────────────
			if (params.session && params.task) {
				const s = tmuxRunner.getSession(params.session);
				if (!s) return sessionNotFoundError(params.session);

				const startedAt = Date.now();

				onUpdate?.({
					content: [],
					details: { task: params.task, model: s.model, sessionName: params.session, startedAt },
				});

				try {
					const result = await tmuxRunner.battle(params.session, params.task, signal);
					return {
						content: [{ type: "text", text: result.output }],
						details: { task: params.task, model: s.model, sessionName: params.session, startedAt, endedAt: Date.now() },
					};
				} catch (err) {
					const message = toErrorMessage(err);
					return {
						content: [{ type: "text", text: message }],
						details: { task: params.task, model: s.model, sessionName: params.session, startedAt, endedAt: Date.now() },
						isError: true,
					};
				}
			}

			// Should not reach here
			return {
				content: [{ type: "text", text: "Unexpected parameter combination." }],
				details: {},
				isError: true,
			};
		},

		// ── Rendering ───────────────────────────────
		renderCall(args, theme, ctx) {
			if (args.session && args.task) {
				// Battle
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("toolTitle", "\ud83d\udcac")} ${theme.fg("dim", (args.task as string).slice(0, 40))} ${theme.fg("dim", `| ${args.session}`)}`,
					0,
					0,
				);
			}
			if (args.close) {
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", "\u2715 close")} ${theme.fg("dim", (args.session as string) ?? "")}`,
					0,
					0,
				);
			}
			// Single task — show model/session from state if available (set by renderResult)
			const s = ctx.state as { model?: string; sessionName?: string };
			const emoji = args.interactive ? "\ud83d\udcac" : "\u26a1";
			const modelTag = s.model ? theme.fg("dim", `(${s.model})`) : "";
			const sessionTag = s.sessionName ? theme.fg("dim", `| ${s.sessionName}`) : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("toolTitle", emoji)} ${((args.task as string) ?? "").slice(0, 40)}${modelTag ? ` ${modelTag}` : ""}${sessionTag ? ` ${sessionTag}` : ""}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const state = ctx.state as {
				startedAt?: number;
				endedAt?: number;
				interval?: ReturnType<typeof setInterval>;
				model?: string;
				sessionName?: string;
			};

			const details = result.details as SubagentDetails | undefined;
			const taskInfo = details?.task;

			// For close / error responses without task info, render simple text
			if (!taskInfo) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				if (!text && !isPartial) return new Text("", 0, 0);
				return new Text(theme.fg("dim", text), 0, 0);
			}

			// Timer management (bash pattern: interval via invalidate)
			if (details?.startedAt && isPartial && !state.interval) {
				state.startedAt = details.startedAt as number;
				state.interval = setInterval(() => ctx.invalidate(), 100);
			}
			if (!isPartial || ctx.isError) {
				state.endedAt = (details?.endedAt as number) ?? Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}

			// Store resolved info in state so renderCall can show it on next update
			state.model = details?.model;
			state.sessionName = details?.sessionName;

			// Reuse container
			const cmp = (ctx.lastComponent as Container | undefined) ?? new Container();
			cmp.clear();

			// Warning (model downgrade)
			if (details?.warning) {
				cmp.addChild(new Text(theme.fg("warning", details.warning as string), 0, 0));
			}

			// Body: prompt + output (only when result is final)
			const prompt = details?.task as string | undefined;
			const output = result.content[0]?.type === "text" ? result.content[0].text?.trim() : "";
			const hasBody = (prompt || output) && !isPartial;

			if (hasBody) {
				const lines: string[] = [];
				if (prompt) {
					const promptDisplay = (prompt.length > 78 ? `${prompt.slice(0, 78)}...` : prompt).replace(/\n/g, " ");
					lines.push(theme.fg("dim", `> ${promptDisplay}`));
				}
				if (output) {
					const outputLines = output.split("\n").map((line: string) => theme.fg("dim", line));
					lines.push(...outputLines);
				}
				const combined = lines.join("\n");
				if (expanded) {
					cmp.addChild(new Text(`\n${combined}`, 0, 0));
				} else {
					cmp.addChild({
						invalidate: () => {},
						render: (w: number) => {
							const result = renderExpandableOutput(combined, theme, w, 0);
							// Add leading blank line
							return ["", ...result];
						},
					});
				}
			}

			// Timer
			if (state.startedAt) {
				const label = isPartial ? "Elapsed" : "Took";
				const endTime = state.endedAt ?? Date.now();
				const dur = ((endTime - state.startedAt) / 1000).toFixed(1);
				cmp.addChild(new Text(`\n${theme.fg("muted", `${label} ${dur}s`)}`, 0, 0));
			}

			return cmp;
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
