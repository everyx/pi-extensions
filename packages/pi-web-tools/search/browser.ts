/**
 * pi-web-tools — real-browser channel (BrowserSkill / bsk CLI).
 *
 * Drives the user's real, logged-in Chromium browser (SPEC: 真实浏览器通道).
 * Searches navigate directly to the engine's search URL — query, locale and
 * recency as URL params (precise, no DOM dependence). Anti-bot friction
 * (captcha) is handled when it shows up, not pre-empted with input
 * simulation.
 *
 * Per-engine serial queues share one bsk session across a burst of queued
 * searches. bsk errors surface as-is in the TUI; install is bsk's own
 * concern (SPEC: bsk 运行报错透传到 TUI).
 *
 * Follows BrowserSkill's lifecycle: session start → commands with --session
 * → session stop (always, even on error paths).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CHROMIUM_BINARIES } from "../browsers.js";
import { createSerialQueue, type SerialQueue } from "../rate-limit.js";
import type { ChannelSearchContext, EngineId, SearchResultItem, WebSearchParams } from "../types.js";
import { parseLocale } from "./bcp47.js";
import { EXTRACT_SCRIPT, isCaptchaState, parseExtraction, parsePageState, STATE_PROBE_SCRIPT } from "./extract.js";
import { recencyToTbs } from "./recency.js";

const execFileAsync = promisify(execFile);

const BSK = "bsk";

/** Fuse engines: zh queries route to baidu (mainland content), everything
 *  else to google. No system-locale sniffing — the LLM's locale param and
 *  query language are the only signals. */
export function pickEngine(locale?: string): EngineId {
	return parseLocale(locale).language === "zh" ? "baidu" : "google";
}

/** Env gate: disables the real-browser
 *  channel (hermetic tests / offline) BEFORE any CLI probe — no browser
 *  window, no bsk daemon. Test scripts set it so the default suite never
 *  pops a Chromium; opt-in browser tests clear it (PI_WEB_TOOLS_TEST_BSK). */
export function bskDisabled(): boolean {
	return process.env.PI_WEB_TOOLS_NO_BSK === "1";
}

/** Whether the bsk CLI is installed — probed lazily (never at module load).
 *  Only positive results cache: installing bsk mid-session activates the
 *  fuse on the next request instead of needing a restart. */
let bskAvailabilityCache = false;
export async function isBskAvailable(): Promise<boolean> {
	if (bskDisabled()) return false;
	if (bskAvailabilityCache) return true;
	bskAvailabilityCache = (await runBsk(["--version"], 5_000)).ok;
	return bskAvailabilityCache;
}

// One serial queue per engine: a burst of queued searches shares a single
// bsk session (open lazily, close when the queue drains).
const engineQueues: Record<EngineId, SerialQueue<string>> = {
	google: createSerialQueue(openSession, closeSession),
	baidu: createSerialQueue(openSession, closeSession),
};

// Browser lifecycle: when WE launched the Chromium instance (no browser was
// connected), close it a short while after the queues drain — never touch a
// browser the user opened themselves.
const BROWSER_CLOSE_DELAY_MS = 5_000;
let browserLaunchedByUs = false;
let browserPid: number | undefined;
let browserCloseTimer: ReturnType<typeof setTimeout> | undefined;

// ── bsk CLI plumbing ─────────────────────────────────────────────

interface BskResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function runBsk(args: string[], timeoutMs = 30_000): Promise<BskResult> {
	try {
		// --quiet suppresses informational stderr (e.g. the "new bsk version
		// available" notice) so failures surface real errors.
		const { stdout, stderr } = await execFileAsync(BSK, ["--quiet", ...args], {
			timeout: timeoutMs,
			env: { ...process.env, NO_COLOR: "1" },
		});
		return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			stdout: (e.stdout || "").toString().trim(),
			stderr: (e.stderr || "").toString().trim() || (e.message ?? String(err)),
		};
	}
}

// ── browser connection + session lifecycle ───────────────────────

interface BskBrowsersEntry {
	/** bsk 0.1.x reports instance_id / browser_name. */
	instance_id?: string;
	browser_name?: string;
	id?: string;
	browser?: string;
	name?: string;
}

async function connectedBrowsers(): Promise<BskBrowsersEntry[]> {
	const { ok, stdout } = await runBsk(["browsers", "--json"], 10_000);
	if (!ok || !stdout) return [];
	try {
		const parsed = JSON.parse(stdout) as BskBrowsersEntry[] | { browsers?: BskBrowsersEntry[] };
		const list = Array.isArray(parsed) ? parsed : (parsed.browsers ?? []);
		return list.filter((b) => b?.instance_id || b?.browser_name || b?.id || b?.browser || b?.name);
	} catch {
		return [];
	}
}

/** Chromium-family launch candidates, in preference order, per platform. */
function launchCandidates(): { name: string; args: string[] }[] {
	if (process.platform === "darwin") {
		return [
			{ name: "open", args: ["-a", "Google Chrome"] },
			{ name: "open", args: ["-a", "Chromium"] },
			{ name: "open", args: ["-a", "Microsoft Edge"] },
			{ name: "open", args: ["-a", "Brave Browser"] },
			{ name: "open", args: ["-a", "Arc"] },
		];
	}
	if (process.platform === "win32") {
		return ["chrome", "msedge", "brave", "chromium", "arc"].map((n) => ({ name: n, args: [] }));
	}
	// Single-sourced with headless rendering and UA probing (browsers.ts).
	return CHROMIUM_BINARIES.map((n) => ({ name: n, args: [] }));
}

/** Try launching one candidate; resolves with the pid on success, undefined
 * on failure (ENOENT arrives asynchronously via the 'error' event — an
 * unhandled one would crash the process, so it must be listened for). */
function tryLaunch(candidate: { name: string; args: string[] }): Promise<number | undefined> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			// Detached spawn: browsers are long-running; execFile would wait
			// for exit and its timeout would kill the process after ~5s.
			child = spawn(candidate.name, candidate.args, { detached: true, stdio: "ignore" });
		} catch {
			resolve(undefined);
			return;
		}
		child.unref();
		child.on("error", () => resolve(undefined)); // ENOENT etc — try next candidate
		child.on("spawn", () => resolve(child.pid));
	});
}

async function launchBrowser(): Promise<boolean> {
	for (const candidate of launchCandidates()) {
		const pid = await tryLaunch(candidate);
		if (pid !== undefined) {
			browserLaunchedByUs = true;
			browserPid = pid;
			return true;
		}
	}
	return false;
}

/**
 * Schedule closing the browser we launched, a short while after the last
 * session stopped. If a new search arrives before the timer fires, the timer
 * is reset; if sessions are still active, we don't close at all.
 */
function scheduleBrowserClose(): void {
	if (!browserLaunchedByUs || browserPid === undefined) return;
	if (browserCloseTimer) clearTimeout(browserCloseTimer);
	browserCloseTimer = setTimeout(async () => {
		browserCloseTimer = undefined;
		// Don't kill the browser if another engine still has an active session.
		const { ok, stdout } = await runBsk(["session", "list", "--json"], 10_000);
		if (ok && stdout && stdout !== "[]") return;
		try {
			process.kill(browserPid as number, "SIGTERM");
		} catch {
			// already gone
		}
		browserLaunchedByUs = false;
		browserPid = undefined;
	}, BROWSER_CLOSE_DELAY_MS);
}

/** Ensure a browser is connected: poll, auto-launch once, keep polling. */
async function ensureBrowserConnected(timeoutMs = 15_000): Promise<{ ok: boolean; detail: string }> {
	if ((await connectedBrowsers()).length > 0) return { ok: true, detail: "browser connected" };

	const launched = await launchBrowser();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000));
		if ((await connectedBrowsers()).length > 0) {
			return {
				ok: true,
				detail: launched ? "browser auto-launched and connected" : "browser connected",
			};
		}
	}
	return {
		ok: false,
		detail: launched
			? "launched browser but the bsk extension did not connect"
			: "no Chromium-family browser found to launch; open one manually",
	};
}

async function openSession(): Promise<string> {
	const conn = await ensureBrowserConnected();
	if (!conn.ok) {
		throw new Error(`real-browser channel unavailable: ${conn.detail}`);
	}
	const { ok, stdout } = await runBsk(["session", "start", "--json"]);
	if (!ok) throw new Error("bsk session start failed");
	try {
		const parsed = JSON.parse(stdout) as { sessionId?: string; session_id?: string; id?: string };
		const sessionId = parsed.sessionId ?? parsed.session_id ?? parsed.id;
		if (sessionId) return sessionId;
	} catch {
		// fall through to raw stdout
	}
	if (stdout) return stdout;
	throw new Error("bsk session start returned no id");
}

async function closeSession(sessionId: string): Promise<void> {
	await runBsk(["session", "stop", sessionId]); // positional arg (SKILL)
	// If we launched the browser, schedule closing it after the queues drain.
	scheduleBrowserClose();
}

// ── search execution ─────────────────────────────────────────────

/** Evaluate a JS expression in the session, returning trimmed stdout. */
async function evaluate(sessionId: string, expression: string, timeoutMs: number): Promise<string> {
	const { ok, stdout, stderr } = await runBsk(["evaluate", "--session", sessionId, expression], timeoutMs);
	if (!ok) throw new Error(`bsk evaluate failed: ${stderr || stdout || "unknown error"}`);
	return stdout;
}

/** Build a direct engine search URL (query + locale + recency as params).
 *  google: gl/hl/lr locale params + tbs freshness; baidu is natively
 *  Chinese — no locale params, and no freshness param exists. */
function buildSearchUrl(params: WebSearchParams, engine: EngineId): string {
	const host = engine === "google" ? "www.google.com" : "www.baidu.com";
	const path = engine === "google" ? "/search?q={q}" : "/s?wd={q}";
	const searchParams = new URLSearchParams();
	if (engine === "google" && params.locale) {
		const { language, country } = parseLocale(params.locale);
		if (country) searchParams.set("gl", country);
		searchParams.set("hl", country ? `${language}-${country}` : language);
		searchParams.set("lr", `lang_${language}`);
	}
	if (engine === "google" && params.recency) searchParams.set("tbs", recencyToTbs(params.recency));
	// Translate the structured domain filters into engine operator syntax
	// (SPEC: bsk → site: / -site:).
	let query = params.query;
	for (const d of params.allowed_domains ?? []) query += ` site:${d}`;
	for (const d of params.blocked_domains ?? []) query += ` -site:${d}`;
	const qs = searchParams.size ? `&${searchParams}` : "";
	return `https://${host}${path.replace("{q}", encodeURIComponent(query))}${qs}`;
}

export async function searchWithBsk(params: WebSearchParams, ctx: ChannelSearchContext): Promise<SearchResultItem[]> {
	const engine = pickEngine(params.locale);
	const timeoutMs = ctx.timeoutMs ?? 30_000;
	// baidu has no freshness param — an explicit error beats silently
	// dropping the filter (SPEC: 能力缺失不静默).
	if (params.recency && engine === "baidu") {
		throw new Error(`engine "baidu" does not support recency`);
	}
	// Direct navigation to the engine search URL: query + locale + recency
	// as URL params (precise, no DOM dependence). Recency passes through raw —
	// each engine's translation lives in recency.ts (single source).
	// (fetch fuse — bsk render for web_fetch — lives below)
	const results = await engineQueues[engine].run(async (sessionId) => {
		const nav = await runBsk(["navigate", "--session", sessionId, buildSearchUrl(params, engine)], timeoutMs);
		if (!nav.ok) throw new Error(`real-browser channel: navigate ${engine} failed: ${nav.stderr}`);
		const raw = await evaluate(sessionId, EXTRACT_SCRIPT, timeoutMs);
		const results = parseExtraction(raw);
		if (results.length === 0) {
			// Empty extraction may mean a captcha/anti-bot wall rather than
			// genuinely no results — surface it instead of silently returning 0.
			const probe = await evaluate(sessionId, STATE_PROBE_SCRIPT, timeoutMs);
			if (isCaptchaState(parsePageState(probe))) {
				throw new Error(`real-browser channel: ${engine} blocked with a captcha challenge`);
			}
		}
		return results;
	});

	return results;
}

// ── fetch fuse (web_fetch 链尾: bsk 真实浏览器渲染) ───────────────

/** Real-browser text extraction for fetched pages — the fetch analogue of
 *  EXTRACT_SCRIPT (title + body text, capped): JS runs in the real page,
 *  stdout carries the JSON. */
export const FETCH_CONTENT_SCRIPT = `(() => {
	const title = document.title || "";
	const body = document.body ? document.body.innerText : "";
	return JSON.stringify({ title: title, body: body.slice(0, 200000) });
})()`;

// One serial queue for fetches (distinct from the per-engine search queues —
// fetch has no engine; the queue just serializes bsk sessions).
const fetchQueue = createSerialQueue(openSession, closeSession);

/** Render a URL in the real browser and return its body text; null when bsk
 *  is unavailable or navigation/extraction failed (caller advances or falls
 *  back). */
export async function fetchUrlWithBsk(url: string, timeoutMs = 30_000): Promise<string | null> {
	if (!(await isBskAvailable())) return null;
	try {
		return await fetchQueue.run(async (sessionId) => {
			const nav = await runBsk(["navigate", "--session", sessionId, url], timeoutMs);
			if (!nav.ok) return null;
			const raw = await evaluate(sessionId, FETCH_CONTENT_SCRIPT, timeoutMs);
			try {
				const parsed = JSON.parse(raw) as { title?: string; body?: string };
				return (parsed.body ?? raw.trim()).trim() || null;
			} catch {
				return raw.trim() || null;
			}
		});
	} catch {
		return null;
	}
}
