/**
 * Spawn session lifecycle — the deep module behind the agent_spawn tool.
 *
 * One interface, three physical paths (foreground / background / persistent)
 * that never leak out: callers hand in an already-constructed agent plus
 * intent-level hooks, and get back one discriminated outcome that says how
 * the session ended. Abort wiring, late-abort guarding, teardown and outcome
 * classification all live here — the matrix that used to hide inside execute
 * is now directly table-testable.
 *
 * Streamed-text accumulation is NOT here: delta/activity callbacks are
 * AgentProcess constructor parameters, so they belong to the constructing
 * side (execute) — the module starts where the agent already exists.
 *
 * Hooks carry intent ("refresh the working card", "a background spawn
 * settled"), never mechanism: pi/registry/widget stay on the caller's side
 * of the seam.
 */

import type { AgentCompletion } from "./agent-process.js";
import type { RenderEvent } from "./types.js";

/** Structural view of what this module needs from an agent — narrow on
 *  purpose: tests build literal fakes instead of mocking AgentProcess. */
export interface SpawnSessionAgent {
	agentId: string;
	title: string;
	model?: string;
	thinking?: string;
	startedAt: number;
	persistent?: boolean;
	status: "queued" | "running" | "completed" | "failed" | "stopped";
	stoppedByControl: boolean;
	spawnAndSend(prompt: string): Promise<{ ok: true } | { ok: false; error: string }>;
	waitForCompletion(): Promise<AgentCompletion>;
	stop(): Promise<void>;
	getEvents(): RenderEvent[];
}

/** How a spawned session ended. `background-started` means the tool result
 *  returns immediately; the completion chain is the caller's via the
 *  onBackgroundSettled hook. A user abort surfaces as finished/stopped with
 *  stoppedByControl — it is an outcome, not a separate kind. */
export type SpawnOutcome =
	| { kind: "spawn-failed"; error: string }
	| { kind: "background-started"; agent: SpawnSessionAgent; startedAt: number }
	| {
			kind: "finished";
			status: AgentCompletion["status"];
			output: string;
			stoppedByControl: boolean;
			/** completed + persistent: the process stays resident (the caller
			 *  was told via onResident); every other ending was torn down. */
			resident: boolean;
			events: RenderEvent[];
			sessionPath?: string;
			sessionId?: string;
			startedAt: number;
			endedAt: number;
	  };

/** Intent-level callbacks. All optional; mechanisms live in the caller. */
interface SpawnSessionHooks {
	/** Foreground, before the spawn settles — the initial "Working…" card. */
	onWorking?(): void;
	/** Background, before the spawn settles — the starting spinner line. */
	onBackgroundStarting?(): void;
	/** Background spawn settled OK: caller wires widget/registry/completion. */
	onBackgroundSettled?(agent: SpawnSessionAgent): void;
	/** Foreground spawn settled OK (process up, task sent): symmetric with
	 *  onBackgroundSettled — the caller reports the child upward (tree
	 *  telemetry) here. */
	onForegroundSettled?(agent: SpawnSessionAgent): void;
	/** Foreground persistent completed: caller registers + marks idle. */
	onResident?(agent: SpawnSessionAgent): void;
}

export async function runSpawnSession(
	agent: SpawnSessionAgent,
	opts: { task: string; runInBackground: boolean; signal?: AbortSignal; hooks?: SpawnSessionHooks },
): Promise<SpawnOutcome> {
	const { task, runInBackground, signal, hooks = {} } = opts;

	// Wire the abort signal to a graceful stop. Guarded: only stop while the
	// agent is still live — a late abort (signal outliving this call) must
	// not stop an agent already at a terminal state or flip stoppedByControl.
	const onAbort = () => {
		if (agent.status === "queued" || agent.status === "running") void agent.stop();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const detach = () => signal?.removeEventListener("abort", onAbort);
	const teardown = async () => {
		detach();
		await agent.stop().catch(() => {});
	};

	try {
		if (runInBackground) hooks.onBackgroundStarting?.();
		else hooks.onWorking?.();

		const started = await agent.spawnAndSend(task);
		if (!started.ok) {
			await teardown();
			return { kind: "spawn-failed", error: started.error };
		}

		// Background: return now. The abort listener detaches here — once the
		// spawn settled, the agent runs on its own and a late abort must not
		// kill it; the user controls it via agent_stop.
		if (runInBackground) {
			detach();
			hooks.onBackgroundSettled?.(agent);
			return { kind: "background-started", agent, startedAt: agent.startedAt };
		}

		hooks.onForegroundSettled?.(agent);

		const completion = await agent.waitForCompletion();
		detach();

		// Persistent: resident after completion — nothing to tear down; the
		// caller registers it so agent_send can wake it later. Every other
		// ending stops the child (idempotent at terminal states).
		const resident = agent.persistent === true && completion.status === "completed";
		if (resident) hooks.onResident?.(agent);
		else await teardown();

		return {
			kind: "finished",
			status: completion.status,
			output: completion.output,
			stoppedByControl: agent.stoppedByControl,
			resident,
			events: agent.getEvents(),
			sessionPath: completion.sessionPath,
			sessionId: completion.sessionId,
			startedAt: agent.startedAt,
			endedAt: Date.now(),
		};
	} catch (err) {
		await teardown();
		throw err;
	}
}
