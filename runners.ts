/**
 * pi-subagent — runner ledger.
 *
 * Tracks live sub-agent child pids in a small JSON file under the session
 * dir, so a *reloaded* extension (or a host that crashed before cleanup)
 * can find and terminate them. The rpc children are detached process groups
 * whose stdin pipe stays open across a /reload — without this ledger they
 * would hang forever as resident orphans, invisible to the new module.
 *
 * Normal runs keep the ledger empty: every spawn tracks, every child exit
 * untracks. The file only ever holds runners from a live session that
 * vanished.
 *
 * Pure + fs — unit tested against real temporary files and a real child.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RunnerRecord {
	pid: number;
	agentId: string;
	title: string;
	startedAt: number;
}

export function runnerFilePath(sessionDir: string): string {
	return path.join(sessionDir, ".runners.json");
}

/** Load the ledger; a missing or corrupt file reads as empty. */
export function loadRunners(file: string): RunnerRecord[] {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (Array.isArray(raw)) {
			return raw.filter((r): r is RunnerRecord => typeof (r as RunnerRecord)?.pid === "number");
		}
	} catch {
		// missing / unreadable / corrupt — treat as empty
	}
	return [];
}

/** Persist the ledger (synchronous: no interleaving in the event loop). */
export function saveRunners(file: string, records: RunnerRecord[]): void {
	try {
		fs.writeFileSync(file, JSON.stringify(records, null, "\t"));
	} catch {
		// best-effort: a full disk must not block spawning
	}
}

/**
 * Kill runner processes that predate this module load (extension reload,
 * host crash): they are orphans whose stdin pipe is still open. Signals the
 * whole detached process group (-pid) so bash grandchildren die too, then
 * clears the ledger. Returns how many processes were signalled.
 */
export function reapRunners(file: string): number {
	const alive = loadRunners(file).filter((r) => {
		try {
			process.kill(r.pid, 0);
			return true;
		} catch {
			return false; // already gone
		}
	});
	for (const r of alive) {
		try {
			process.kill(-r.pid, "SIGTERM");
		} catch {
			try {
				process.kill(r.pid, "SIGTERM"); // non-Unix: no process group
			} catch {
				// already gone
			}
		}
	}
	saveRunners(file, []);
	return alive.length;
}

/** Default per-AgentProcess ledger wiring (no-op when no session dir). */
export function defaultRunner(sessionDir: string): { track(rec: RunnerRecord): void; untrack(pid: number): void } {
	const file = runnerFilePath(sessionDir);
	return {
		track: (rec) => saveRunners(file, [...loadRunners(file).filter((r) => r.pid !== rec.pid), rec]),
		untrack: (pid) =>
			saveRunners(
				file,
				loadRunners(file).filter((r) => r.pid !== pid),
			),
	};
}
