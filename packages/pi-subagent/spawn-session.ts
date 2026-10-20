/**
 * Spawn session lifecycle — the deep module behind the agent_spawn tool.
 *
 * One interface, one physical path: every spawn returns as soon as the child
 * has accepted the task. The result arrives later as a completion
 * notification; the caller keeps an id and can intervene meanwhile.
 *
 * Why there is no blocking variant: a blocking spawn holds the caller's whole
 * turn hostage — nothing else runs, and the caller cannot even decide to give
 * up. Every problem a blocking spawn "solved" (having the answer inline) is
 * solved better by the notification, which costs the same number of model
 * requests but leaves the caller free in between.
 *
 * Nested agents are where this matters most. A sub-agent that spawns a child
 * keeps running (it is a live pi process), and its child's result comes back
 * as a notification like any other. The child must therefore outlive the
 * sub-agent's turn — see the drain rule below.
 *
 * Abort wiring, teardown, and outcome classification live here; the caller
 * owns the completion chain (it is the only side that knows the display
 * surfaces).
 */

import type { AgentCompletion } from "./agent-process.js";
import type { RenderEvent } from "./types.js";

/** Structural view of what this module needs from an agent — narrow on
 *  purpose: tests build literal fakes instead of mocking AgentProcess. */
export interface SpawnSessionAgent {
	agentId: string;
	label: string;
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

/** How a spawned session ended. `started` means the tool call returns now and
 *  the completion chain is the caller's via the onStarted hook. A spawn
 *  failure is the only other shape: the child never accepted the task, so
 *  there is nothing to wait for and nothing to notify. */
export type SpawnOutcome =
	| { kind: "spawn-failed"; error: string }
	| { kind: "started"; agent: SpawnSessionAgent; startedAt: number };

/** Intent-level callbacks. All optional; mechanisms live in the caller. */
interface SpawnSessionHooks {
	/** Before the spawn settles — the starting spinner line. */
	onStarting?(): void;
	/** The child accepted the task and runs on its own: caller wires the
	 *  widget row, the registry entry, and the completion chain. */
	onStarted?(agent: SpawnSessionAgent): void;
}

export async function runSpawnSession(
	agent: SpawnSessionAgent,
	opts: { task: string; signal?: AbortSignal; hooks?: SpawnSessionHooks },
): Promise<SpawnOutcome> {
	const { task, signal, hooks = {} } = opts;

	// Wire the abort signal to a graceful stop. Guarded: only stop while the
	// agent is still live — a late abort (signal outliving this call) must
	// not stop an agent already at a terminal state or flip stoppedByControl.
	const onAbort = () => {
		if (agent.status === "queued" || agent.status === "running") void agent.stop();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const detach = () => signal?.removeEventListener("abort", onAbort);

	try {
		hooks.onStarting?.();

		const started = await agent.spawnAndSend(task);
		if (!started.ok) {
			detach();
			await agent.stop().catch(() => {});
			return { kind: "spawn-failed", error: started.error };
		}

		// The spawn settled: the child owns its task now. The abort listener
		// detaches here — once the spawn settled, the agent runs on its own and
		// a late abort must not kill it; the caller controls it via agent_stop.
		detach();
		hooks.onStarted?.(agent);
		return { kind: "started", agent, startedAt: agent.startedAt };
	} catch (err) {
		detach();
		await agent.stop().catch(() => {});
		throw err;
	}
}

/**
 * The drain rule: an agent's own turn ending does not mean its work is over —
 * agents it spawned may still be running, and they die with it (their stdin
 * pipe closes with the process). So before an agent is torn down or reported,
 * ask whether its subtree is empty; if not, hold it (idle, zero token) until
 * it is.
 *
 * Returns whether it had to wait, so the caller can mark the agent idle for
 * exactly as long as it is held — no longer.
 */
export async function holdUntilDrained(opts: {
	hasLiveDescendants(): boolean;
	waitForDrain(): Promise<void>;
	/** The agent is now held: show it as alive-but-not-working. */
	onHeld(): void;
}): Promise<boolean> {
	if (!opts.hasLiveDescendants()) return false;
	opts.onHeld();
	await opts.waitForDrain();
	return true;
}

/** What the drain rule needs to know about the live tree — structural so a
 *  test can hand in a fake or the real one. */
export interface DrainSource {
	hasLiveDescendants(agentId: string): boolean;
	whenDrained(agentId: string): Promise<void>;
}

/**
 * The whole completion policy for one spawn: wait for its turn, hold it while
 * descendants are still running, then run `finish` (report + cleanup).
 *
 * This lives here — not inline in the tool callback — because it is the one
 * place the two halves of the lifecycle meet (a child's own turn vs. work
 * still running beneath it). An integration test can drive it with the real
 * registry and the real live tree, which is the only way to lock the
 * guarantee down: a unit test of each half would pass even if the wiring
 * between them were wrong.
 */
export async function finishWhenDrained(opts: {
	agentId: string;
	live: DrainSource;
	/** The agent is now held: show it as alive-but-not-working. */
	onHeld(): void;
	/** Report + clean up. Runs exactly once, after the subtree drains. */
	finish(): void | Promise<void>;
}): Promise<void> {
	await holdUntilDrained({
		hasLiveDescendants: () => opts.live.hasLiveDescendants(opts.agentId),
		waitForDrain: () => opts.live.whenDrained(opts.agentId),
		onHeld: opts.onHeld,
	});
	await opts.finish();
}
