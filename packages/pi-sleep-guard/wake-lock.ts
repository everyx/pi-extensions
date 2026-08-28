/**
 * pi-sleep-guard — wake-lock module.
 *
 * One lock per pi process. The lock is held by supervising a long-lived OS
 * child whose whole job is to carry the platform's sleep inhibitor; the
 * child watches our pid and self-terminates when we die, so a crashed pi
 * can never leave an orphan keeping the machine awake (RAII without
 * cleanup-path correctness).
 *
 * System-wide effect needs no cross-process coordination: sleep inhibitors
 * are OR-semantics at the OS level — any single holder keeps the machine
 * awake. Each pi process (main or `pi --mode rpc` sub-agent child) holds
 * its own lock exactly while its own agent runs.
 *
 * Platform holders (all zero-dependency, no native addons):
 *   darwin  caffeine(1): `caffeinate -i [-d] -w <our pid>` — kernel waits on us
 *   linux   systemd-inhibit(1) wrapping a shell loop that polls `kill -0 <pid>`
 *   win32   PowerShell holding SetThreadExecutionState(ES_CONTINUOUS |
 *           SYSTEM_REQUIRED [| DISPLAY_REQUIRED]), polling our pid
 */

import { type ChildProcess, spawn } from "node:child_process";

/** A ready-to-spawn holder process. `null` = this platform has no backend. */
export interface HolderPlan {
	cmd: string;
	args: string[];
}

const WATCH_INTERVAL_SECONDS = 5;

/**
 * Pure decision layer: which holder process carries the inhibitor for this
 * platform. Table-tested; never touches the filesystem or spawns anything.
 *
 * `watcherPid` is the pid of the process whose death must release the lock
 * (normally our own process.pid).
 */
export function buildHolder(
	platform: NodeJS.Platform,
	opts: { display: boolean; watcherPid: number },
): HolderPlan | null {
	switch (platform) {
		case "darwin": {
			const args = ["-i"];
			if (opts.display) args.push("-d");
			// -w: exit (and drop the assertion) when watcherPid dies.
			args.push("-w", String(opts.watcherPid));
			return { cmd: "caffeinate", args };
		}
		case "linux":
			// systemd-inhibit has no display axis; screen blanking falls under the
			// idle lock. Platform capability difference — stated, not papered over.
			return {
				cmd: "systemd-inhibit",
				args: [
					"--who",
					"pi-sleep-guard",
					"--what",
					"sleep:idle",
					"--why",
					"pi agent running",
					"sh",
					"-c",
					`while kill -0 ${opts.watcherPid} 2>/dev/null; do sleep ${WATCH_INTERVAL_SECONDS}; done`,
				],
			};
		case "win32": {
			// SetThreadExecutionState: ES_CONTINUOUS(0x80000000) holds the request on
			// this thread until the process exits; SYSTEM_REQUIRED(1) blocks system
			// sleep, DISPLAY_REQUIRED(2) additionally blocks display off.
			const flags = opts.display ? "0x80000003" : "0x80000001";
			const script = [
				"$sig='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
				"$f=Add-Type -MemberDefinition $sig -Name W -Namespace SleepGuard -PassThru",
				`$null=$f::SetThreadExecutionState(${flags})`,
				`while($true){ try{Get-Process -Id ${opts.watcherPid} -ErrorAction Stop|Out-Null}catch{break}; Start-Sleep -Seconds ${WATCH_INTERVAL_SECONDS} }`,
			].join("; ");
			// -EncodedCommand: base64 UTF-16LE, sidescapes every quoting pitfall.
			return {
				cmd: "powershell",
				args: ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
			};
		}
		default:
			return null;
	}
}

/** What went wrong when a lock failed to become active (for the one-time notice). */
export type LockFailure = { reason: "no-backend"; platform: string } | { reason: "spawn-failed"; detail: string };

/** Narrow spawn seam — tests inject a fake instead of spawning real holders. */
export type Spawner = (cmd: string, args: string[]) => ChildProcess;

export interface WakeLockOptions {
	display?: boolean;
	spawn?: Spawner;
	warn?: (failure: LockFailure) => void;
}

/**
 * Idempotent lock around one holder child process. Multiple overlapping
 * acquires (e.g. agent retries/compaction) are collapsed — one release
 * drops the holder. This prevents a leaked inhibitor when agent_start
 * fires twice before agent_settled.
 */
export class WakeLock {
	#child: ChildProcess | null = null;
	#warned = false;
	readonly #platform: NodeJS.Platform;
	readonly #display: boolean;
	readonly #spawn: Spawner;
	readonly #warn: (failure: LockFailure) => void;

	constructor(platform: NodeJS.Platform, opts: WakeLockOptions = {}) {
		this.#platform = platform;
		this.#display = opts.display ?? false;
		this.#spawn = opts.spawn ?? ((cmd, args) => spawn(cmd, args, { stdio: "ignore" }));
		this.#warn =
			opts.warn ??
			((f) => {
				const detail = f.reason === "no-backend" ? `no backend for ${f.platform}` : f.detail;
				console.error(`pi-sleep-guard: cannot block system sleep (${detail}); continuing without it`);
			});
	}

	/** True only when a holder process is verifiably alive right now. */
	get active(): boolean {
		return this.#child !== null;
	}

	acquire(): void {
		if (this.#child) return;
		const plan = buildHolder(this.#platform, { display: this.#display, watcherPid: process.pid });
		if (!plan) {
			this.#warnOnce({ reason: "no-backend", platform: this.#platform });
			return;
		}
		try {
			const child = this.#spawn(plan.cmd, plan.args);
			child.on("error", () => {
				// spawn failure surfaces asynchronously on some platforms — only
				// retire our own child; a later acquire() may hold a newer one.
				if (this.#child === child) {
					this.#child = null;
					this.#warnOnce({ reason: "spawn-failed", detail: `${plan.cmd} failed to start` });
				}
			});
			this.#child = child;
		} catch (err) {
			this.#child = null;
			this.#warnOnce({ reason: "spawn-failed", detail: err instanceof Error ? err.message : String(err) });
		}
	}

	release(): void {
		if (this.#child) {
			this.#child.kill();
			this.#child = null;
		}
	}

	#warnOnce(failure: LockFailure): void {
		if (this.#warned) return;
		this.#warned = true;
		this.#warn(failure);
	}
}
