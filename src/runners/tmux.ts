/**
 * pi-subagent — thin async wrapper over the `tmux` CLI.
 *
 * All spawn/sync exec goes through `tmuxCmd` so the runner never blocks the
 * event loop and so tests can stub this module. Targets are quoted defensively
 * by the caller (we just pass argv).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run `tmux …args` and resolve stdout (trimmed). Rejects on non‑zero exit. */
export function tmuxCmd(args: string[]): Promise<string> {
	return execFileP("tmux", args, { maxBuffer: 16 * 1024 }).then((r) => r.stdout.trim());
}

/** Kill a session, ignoring "no server"/"unknown session". */
export async function tmuxKill(name: string): Promise<void> {
	try {
		await tmuxCmd(["kill-session", "-t", name]);
	} catch {
		/* already dead or no server */
	}
}
