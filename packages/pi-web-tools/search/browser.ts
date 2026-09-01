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
 * concern (SPEC: bsk 运行报错透传到 TUI). Browser ownership (launch ours,
 * close ours, never the user's) lives in bsk-browser.ts.
 *
 * Follows BrowserSkill's lifecycle: session start → commands with --session
 * → session stop (always, even on error paths).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CHROMIUM_BINARIES } from "../browsers.js";
import { createSerialQueue, type SerialQueue } from "../rate-limit.js";
import type { ChannelSearchContext, EngineId, RenderedContent, SearchResultItem, WebSearchParams } from "../types.js";
import { parseLocale } from "./bcp47.js";
import { BskBrowser, type BskResult } from "./bsk-browser.js";
import { EXTRACT_SCRIPT, isCaptchaState, parseExtraction, parsePageState, STATE_PROBE_SCRIPT } from "./extract.js";
import { recencyToTbs } from "./recency.js";

const execFileAsync = promisify(execFile);

const BSK = "bsk";

/** Fuse engines: zh locale routes to baidu (mainland content), everything
 *  else to google. No system-locale sniffing — the LLM's locale param is the
 *  only routing signal. */
export function pickEngine(locale?: string): EngineId {
	return parseLocale(locale).language === "zh" ? "baidu" : "google";
}

/** Env gate: disables the real-browser
 *  channel (hermetic tests / offline) BEFORE any CLI probe — no browser
 *  window, no bsk daemon. Test scripts set it so the default suite never
 *  pops a Chromium; opt-in browser tests clear it (PI_WEB_TOOLS_TEST_BSK). */
function bskDisabled(): boolean {
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

// ── bsk CLI plumbing ─────────────────────────────────────────────

async function runBsk(args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<BskResult> {
	try {
		// --quiet suppresses informational stderr (e.g. the "new bsk version
		// available" notice) so failures surface real errors.
		const { stdout, stderr } = await execFileAsync(BSK, ["--quiet", ...args], {
			timeout: timeoutMs,
			env: { ...process.env, NO_COLOR: "1" },
			signal,
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

// ── browser launch candidates ────────────────────────────────────

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
	// Single-sourced with bsk's launch candidates (browsers.ts).
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

/** Launch the first candidate that starts; the pid is the ownership handle
 *  the lifecycle module closes (bsk-browser.ts). */
async function launchBrowser(): Promise<number | undefined> {
	for (const candidate of launchCandidates()) {
		const pid = await tryLaunch(candidate);
		if (pid !== undefined) return pid;
	}
	return undefined;
}

// ── browser lifecycle (ownership) ────────────────────────────────
// When WE launched the Chromium instance (no browser was connected), close
// it a short while after the queues drain — never touch a browser the user
// opened themselves. The decision logic + ownership state live in
// bsk-browser.ts (injected dependencies, tested with fakes).
const BROWSER_CLOSE_DELAY_MS = 5_000;
const lifecycle = new BskBrowser({
	runBsk,
	launchBrowser,
	killBrowser: (pid) => process.kill(pid, "SIGTERM"),
	closeDelayMs: BROWSER_CLOSE_DELAY_MS,
});

// One serial queue per engine: a burst of queued searches shares a single
// bsk session (open lazily, close when the queue drains).
const engineQueues: Record<EngineId, SerialQueue<string>> = {
	google: createSerialQueue(
		() => lifecycle.startSession(),
		(id) => lifecycle.stopSession(id),
	),
	baidu: createSerialQueue(
		() => lifecycle.startSession(),
		(id) => lifecycle.stopSession(id),
	),
};

// ── search execution ─────────────────────────────────────────────

/** Evaluate a JS expression in the session, returning trimmed stdout. */
async function evaluate(
	sessionId: string,
	expression: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	const { ok, stdout, stderr } = await runBsk(["evaluate", "--session", sessionId, expression], timeoutMs, signal);
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
	const timeoutMs = 30_000; // bsk attempt budget (runBsk's own default)
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
		const nav = await runBsk(
			["navigate", "--session", sessionId, buildSearchUrl(params, engine)],
			timeoutMs,
			ctx.signal,
		);
		if (!nav.ok) throw new Error(`real-browser channel: navigate ${engine} failed: ${nav.stderr}`);
		const raw = await evaluate(sessionId, EXTRACT_SCRIPT, timeoutMs, ctx.signal);
		const results = parseExtraction(raw);
		if (results.length === 0) {
			// Empty extraction may mean a captcha/anti-bot wall rather than
			// genuinely no results — surface it instead of silently returning 0.
			const probe = await evaluate(sessionId, STATE_PROBE_SCRIPT, timeoutMs, ctx.signal);
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
const FETCH_CONTENT_SCRIPT = `(() => {
	const title = document.title || "";
	const body = document.body ? document.body.innerText : "";
	return JSON.stringify({ title: title, body: body.slice(0, 200000) });
})()`;

// One serial queue for fetches (distinct from the per-engine search queues —
// fetch has no engine; the queue just serializes bsk sessions).
const fetchQueue = createSerialQueue(
	() => lifecycle.startSession(),
	(id) => lifecycle.stopSession(id),
);

/** Render a URL in the real browser; null when bsk is unavailable or
 *  navigation/extraction failed (caller advances or falls back). The text
 *  is the page's innerText — plain text, self-reported as such. */
export async function fetchUrlWithBsk(
	url: string,
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<RenderedContent | null> {
	if (!(await isBskAvailable())) return null;
	try {
		return await fetchQueue.run(async (sessionId) => {
			const nav = await runBsk(["navigate", "--session", sessionId, url], timeoutMs, signal);
			if (!nav.ok) return null;
			const raw = await evaluate(sessionId, FETCH_CONTENT_SCRIPT, timeoutMs, signal);
			try {
				const parsed = JSON.parse(raw) as { title?: string; body?: string };
				const text = (parsed.body ?? raw.trim()).trim();
				return text ? { text, contentType: "text/plain" } : null;
			} catch {
				const text = raw.trim();
				return text ? { text, contentType: "text/plain" } : null;
			}
		});
	} catch {
		return null;
	}
}
