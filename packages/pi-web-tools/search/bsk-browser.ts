/**
 * pi-web-tools — bsk browser lifecycle: who owns the Chromium instance.
 *
 * bsk (the CLI) talks to an already-running browser through its extension.
 * When no browser is connected, WE launch one — and only that instance is
 * closed (a short while after the last session stops). A browser the user
 * opened themselves is never touched.
 *
 * The decision logic is a class with injected dependencies (CLI runner,
 * launcher, killer, delays) so tests drive connect → launch → close with
 * fakes (test/bsk-browser.test.ts) instead of a real browser.
 */

/** One bsk CLI call result (never throws — ok flags success). */
export interface BskResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export type BskRunner = (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<BskResult>;

/** bsk 0.1.x reports instance_id / browser_name; older/newer versions may
 *  use the shorter keys. */
interface BskBrowsersEntry {
	instance_id?: string;
	browser_name?: string;
	id?: string;
	browser?: string;
	name?: string;
}

export interface BskBrowserControls {
	/** Run one bsk CLI command (production: execFile; tests: fake). */
	runBsk: BskRunner;
	/** Launch a Chromium-family browser; resolves with the pid when one
	 *  started (production: platform candidates; tests: fake). */
	launchBrowser: () => Promise<number | undefined>;
	/** Kill the launched browser (production: SIGTERM; tests: spy). */
	killBrowser: (pid: number) => void;
	/** Delay after the last session before closing a self-launched browser
	 *  (production: 5s — a new search may follow; tests: tiny). */
	closeDelayMs: number;
	/** Poll interval while waiting for a browser to connect (production:
	 *  1s; tests: tiny). */
	pollIntervalMs?: number;
}

/** Parse the session id from `bsk session start --json` — bsk reports the
 *  id under varying keys across versions; a non-JSON stdout is the id
 *  itself. */
export function parseBskSessionId(stdout: string): string | undefined {
	const raw = stdout.trim();
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { sessionId?: string; session_id?: string; id?: string };
		return parsed.sessionId ?? parsed.session_id ?? parsed.id;
	} catch {
		return raw;
	}
}

/**
 * Browser ownership state machine:
 *   - ensureConnected: poll for a connected browser; launch once if none;
 *     poll until it connects or the deadline passes.
 *   - stopSession: stop the bsk session; when WE launched the browser,
 *     schedule its close (reset on each stop; skipped when another session
 *     is still active — another engine's queue may still be draining).
 */
export class BskBrowser {
	private launched = false;
	private pid: number | undefined;
	private closeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly controls: BskBrowserControls) {}

	/** Browsers currently connected to the bsk daemon. */
	async connectedBrowsers(): Promise<BskBrowsersEntry[]> {
		const { ok, stdout } = await this.controls.runBsk(["browsers", "--json"], 10_000);
		if (!ok || !stdout) return [];
		try {
			const parsed = JSON.parse(stdout) as BskBrowsersEntry[] | { browsers?: BskBrowsersEntry[] };
			const list = Array.isArray(parsed) ? parsed : (parsed.browsers ?? []);
			return list.filter((b) => b?.instance_id || b?.browser_name || b?.id || b?.browser || b?.name);
		} catch {
			return [];
		}
	}

	/** Ensure a browser is connected: poll, auto-launch once, keep polling. */
	async ensureConnected(timeoutMs = 15_000): Promise<{ ok: boolean; detail: string }> {
		if ((await this.connectedBrowsers()).length > 0) {
			return { ok: true, detail: "browser connected" };
		}
		const pid = await this.controls.launchBrowser();
		if (pid !== undefined) {
			this.launched = true;
			this.pid = pid;
		}
		const pollMs = this.controls.pollIntervalMs ?? 1_000;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, pollMs));
			if ((await this.connectedBrowsers()).length > 0) {
				return {
					ok: true,
					detail: this.launched ? "browser auto-launched and connected" : "browser connected",
				};
			}
		}
		return {
			ok: false,
			detail: this.launched
				? "launched browser but the bsk extension did not connect"
				: "no Chromium-family browser found to launch; open one manually",
		};
	}

	/** Start a bsk session (launching a browser first when needed). */
	async startSession(): Promise<string> {
		const conn = await this.ensureConnected();
		if (!conn.ok) {
			throw new Error(`real-browser channel unavailable: ${conn.detail}`);
		}
		const { ok, stdout } = await this.controls.runBsk(["session", "start", "--json"]);
		if (!ok) throw new Error("bsk session start failed");
		const sessionId = parseBskSessionId(stdout);
		if (sessionId) return sessionId;
		throw new Error("bsk session start returned no id");
	}

	/** Stop a bsk session; schedules the browser close when we own it. */
	async stopSession(sessionId: string): Promise<void> {
		await this.controls.runBsk(["session", "stop", sessionId]);
		this.scheduleClose();
	}

	/** Schedule closing the browser WE launched, a short while after the
	 *  last session stopped. A new stop resets the timer; sessions still
	 *  active at fire time (another engine's queue draining) abort the
	 *  close. Never touches a browser the user opened themselves. */
	private scheduleClose(): void {
		if (!this.launched || this.pid === undefined) return;
		const pid = this.pid;
		if (this.closeTimer) clearTimeout(this.closeTimer);
		this.closeTimer = setTimeout(async () => {
			this.closeTimer = undefined;
			const { ok, stdout } = await this.controls.runBsk(["session", "list", "--json"], 10_000);
			if (ok && stdout && stdout !== "[]") return;
			try {
				this.controls.killBrowser(pid);
			} catch {
				// already gone
			}
			this.launched = false;
			this.pid = undefined;
		}, this.controls.closeDelayMs);
	}
}
