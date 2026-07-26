/**
 * pi-subagent – Spawn isolated sub‑agent pi instances.
 *
 * Architecture:
 *   index.ts         — tool registration, mode dispatch, shutdown, cleanup
 *   child.ts         — child‑mode handlers (socket report)
 *   modes.ts         — pure param‑to‑discriminated‑union parser (testable)
 *   model.ts         — model‑spec → ResolvedModel (testable)
 *   protocol.ts      — length‑prefixed socket framing (tested)
 *   events.ts        — JSON‑lines event stream parser (testable)
 *   render.ts        — TUI rendering helpers (renderCall / renderResult)
 *   utils.ts         — shared utilities (lastAssistantText)
 *   runners/
 *     types.ts       — shared result/option types
 *     print.ts       — PrintRunner (pi --print --no-session)
 *     interactive.ts — InteractiveRunner (tmux + socket + pi -n)
 *
 * Two‑mode startup:
 *   Parent mode (no env vars) → registers the `subagent` tool
 *   Child  mode (env var set) → hooks agent_end + agent_settled, reports back
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activateChildMode } from "./child.js";
import { resolveModel } from "./model.js";
import { parseMode, type SubagentParams } from "./modes.js";
import { getState, releaseState, renderCall, renderResult } from "./render.js";
import { InteractiveRunner } from "./runners/interactive.js";
import { PrintRunner } from "./runners/print.js";
import type { SubagentResult } from "./runners/types.js";

// ─── Temp dir (created at module init, cleaned up on shutdown) ─

let _tmpDir: string | null = null;
function getTmpDir(): string {
	if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	return _tmpDir;
}

// ─── Runner singletons ─────────────────────────────────

const printRunner = new PrintRunner();
const interactiveRunner = new InteractiveRunner(getTmpDir());

// ─── Tool parameter schema ─────────────────────────────

const ToolParamsSchema = Type.Object({
	task: Type.Optional(
		Type.String({
			description:
				"Task prompt for the sub‑agent. " +
				"Provide `task` alone for a single execution, " +
				"or `session` + `task` for battle mode.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Optional. Defaults to parent model — omit unless you need a different one. " +
				"Format: provider/name or just model name.",
		}),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist" })),
	interactive: Type.Optional(
		Type.Boolean({ description: "Spawn in tmux (attachable). Default: false (non‑interactive)", default: false }),
	),
	session: Type.Optional(Type.String({ description: "Existing interactive session name for battle or close" })),
	close: Type.Optional(Type.Boolean({ description: "Close an interactive session (requires `session`)" })),
});

// ─── Helpers ───────────────────────────────────────────

function toErrorResult(err: unknown): {
	content: { type: "text"; text: string }[];
	details: Record<string, never>;
	isError: true;
} {
	return {
		content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
		details: {},
		isError: true,
	};
}

function sessionNotFound(session: string) {
	return {
		content: [{ type: "text" as const, text: `Session "${session}" not found.` }],
		details: {} as const,
		isError: true as const,
	};
}

/** Wire state bridge, run tracking lifecycle, and auto‑cleanup for a mode branch. */
function withTracking(
	toolCallId: string,
	onUpdate: ((...args: never[]) => unknown) | undefined,
	task: string,
	state: { model?: string; sessionName?: string },
	work: () => Promise<SubagentResult>,
) {
	const st = getState(toolCallId);
	if (st) {
		if (state.model !== undefined) st.model = state.model;
		if (state.sessionName !== undefined) st.sessionName = state.sessionName;
	}
	return runWithTracking(onUpdate, { task }, work).finally(() => releaseState(toolCallId));
}

/** Run a sub‑agent execution with consistent tracking lifecycle. */
async function runWithTracking<T extends (...args: never[]) => unknown>(
	onUpdate: T | undefined,
	init: { task: string },
	work: () => Promise<SubagentResult>,
): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: true;
}> {
	const startedAt = Date.now();

	// biome-ignore lint/suspicious/noExplicitAny: pi framework type not importable
	(onUpdate as any)?.({
		content: [],
		details: { ...init, startedAt },
	});

	try {
		const result = await work();
		return {
			content: [{ type: "text", text: result.output }],
			details: { ...init, sessionName: result.sessionName, startedAt, endedAt: Date.now() },
		};
	} catch (err) {
		return {
			content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
			details: { ...init, startedAt, endedAt: Date.now() },
			isError: true,
		};
	}
}

// ─── Default export (pi extension entry) ───────────────────────

export default function (pi: ExtensionAPI) {
	// ── Child mode ────────────────────────────────
	const parentSocket = process.env.PI_SUBAGENT_PARENT_SOCKET;
	if (parentSocket) {
		activateChildMode(pi, parentSocket, process.env.PI_SUBAGENT_SESSION_NAME ?? "");
		return; // Don't register the tool in child mode
	}

	// ── Parent mode ──────────────────────────────
	pi.registerTool({
		name: "subagent",
		label: "Sub‑agent",
		description:
			"Delegate a task to a sub‑agent with an isolated context window. " +
			"Model inherits from parent — omit unless you need a different one. " +
			"Non‑interactive (default): spawns pi --print, captures stdout. " +
			"Interactive (interactive:true): spawns inside tmux, attachable. " +
			"Battle (session + task): send a follow‑up to an interactive session.",
		parameters: ToolParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			const mode = parseMode(raw as SubagentParams);
			if (mode.kind === "error") {
				return { content: [{ type: "text", text: mode.message }], details: {}, isError: true };
			}

			try {
				switch (mode.kind) {
					// ── Close ──────────────────────────────
					case "close": {
						if (!interactiveRunner.getSession(mode.session)) {
							return sessionNotFound(mode.session);
						}
						await interactiveRunner.closeSession(mode.session);
						return {
							content: [{ type: "text", text: `Closed sub‑agent session ${mode.session}` }],
							details: {},
						};
					}

					// ── Print (non‑interactive) ─────────────
					case "print": {
						const resolved = resolveModel(ctx.modelRegistry, ctx.model, mode.model);
						if (resolved.error) {
							return { content: [{ type: "text", text: resolved.error }], details: {}, isError: true };
						}

						return withTracking(_toolCallId, onUpdate, mode.task, { model: resolved.model }, async () => {
							const opts = {
								cwd: ctx.cwd,
								model: resolved.model ?? undefined,
								tools: mode.tools,
								signal,
								onOutput: (output: string) => {
									onUpdate?.({
										content: [{ type: "text", text: output }],
										details: { task: mode.task, startedAt: Date.now() },
									});
								},
							};
							return printRunner.execute(mode.task, opts);
						});
					}

					// ── Interactive ─────────────────────────
					case "interactive": {
						const resolved = resolveModel(ctx.modelRegistry, ctx.model, mode.model);
						if (resolved.error) {
							return { content: [{ type: "text", text: resolved.error }], details: {}, isError: true };
						}

						const sessionName = `pi-sub-${crypto.randomBytes(6).toString("hex")}`;

						return withTracking(_toolCallId, onUpdate, mode.task, { model: resolved.model, sessionName }, async () => {
							const opts = {
								cwd: ctx.cwd,
								model: resolved.model ?? undefined,
								tools: mode.tools,
								signal,
								sessionName,
								onOutput: (output: string) => {
									onUpdate?.({
										content: [{ type: "text", text: output }],
										details: { task: mode.task, startedAt: Date.now() },
									});
								},
							};
							return interactiveRunner.execute(mode.task, opts);
						});
					}

					// ── Battle ──────────────────────────────
					case "battle": {
						const s = interactiveRunner.getSession(mode.session);
						if (!s) return sessionNotFound(mode.session);

						return withTracking(
							_toolCallId,
							onUpdate,
							mode.task,
							{ model: s.model, sessionName: mode.session },
							async () => interactiveRunner.battle(mode.session, mode.task, signal),
						);
					}

					default: {
						const _exhaustive: never = mode;
						return _exhaustive;
					}
				}
			} catch (err) {
				return toErrorResult(err);
			}
		},

		// ── Render call (tool header) ──────────────────────
		renderCall,

		// ── Render result (output body + timer) ────────────
		renderResult,
	});

	// ── Cleanup on exit ───────────────────────────────────
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;

		const names = interactiveRunner.activeSessionNames();

		if (names.length > 0) {
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Sub‑agents still running",
					`${names.length} active: ${names.join(", ")}\nClose them?`,
				);
				if (!ok) return;
			}
			interactiveRunner.killAll();
		} else {
			interactiveRunner.closeServer();
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
