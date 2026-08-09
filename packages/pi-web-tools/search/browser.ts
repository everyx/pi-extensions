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
 * searches (SPEC: 批量搜索一次打开浏览器). bsk errors surface as-is
 * (SPEC: bsk 运行报错透传到 TUI；安装归 bsk 自己).
 *
 * Follows BrowserSkill's lifecycle: session start → commands with --session
 * → session stop (always, even on error paths).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createSerialQueue, type SerialQueue } from "../rate-limit.js";
import type {
	ChannelSearchContext,
	ChannelSearchResult,
	EngineId,
	SearchResultItem,
	WebSearchParams,
} from "../types.js";
import { engineSearchUrl } from "./locale.js";

const execFileAsync = promisify(execFile);

const BSK = "bsk";

// One serial queue per engine: a burst of queued searches shares a single
// bsk session (open lazily, close when the queue drains).
const engineQueues: Record<EngineId, SerialQueue<string>> = {
	google: createSerialQueue(openSession, closeSession),
	bing: createSerialQueue(openSession, closeSession),
	baidu: createSerialQueue(openSession, closeSession),
	yandex: createSerialQueue(openSession, closeSession),
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
	return [
		"chromium",
		"chromium-browser",
		"google-chrome",
		"google-chrome-stable",
		"microsoft-edge",
		"brave-browser",
	].map((n) => ({ name: n, args: [] }));
}

async function launchBrowser(): Promise<boolean> {
	for (const candidate of launchCandidates()) {
		try {
			// Detached spawn: browsers are long-running; execFile would wait
			// for exit and its timeout would kill the process after ~5s.
			const child = spawn(candidate.name, candidate.args, { detached: true, stdio: "ignore" });
			child.unref();
			browserLaunchedByUs = true;
			browserPid = child.pid;
			return true;
		} catch {
			// try next candidate
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
			? "launched browser but the bsk extension did not connect (is the BrowserSkill extension installed?)"
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

/** Extract search results from the page (engine-agnostic: h2/h3-wrapped titles).
 *
 * Ad results are excluded: Google marks them with data-text-ad / adurl,
 * Bing puts them in .b_ad / li[class*='ad'].
 */
const EXTRACT_SCRIPT = String.raw`
(() => {
	const out = [];
	const seen = new Set();
	const isAd = (titleEl, a) => {
		if (a && /adurl|aclk/.test(a.href)) return true;
		for (let n = titleEl.parentElement; n && n !== document.body; n = n.parentElement) {
			const cls = (typeof n.className === 'string' ? n.className : '') + ' ' + (n.getAttribute('data-text-ad') || '') + ' ' + (n.getAttribute('data-ad-text') || '');
			const role = n.getAttribute('role') || '';
			if (/\b(ad|ads|advertisement|sponsored|b_ad)\b/i.test(cls + role)) return true;
		}
		return false;
	};
	const push = (titleEl) => {
		const a = titleEl.closest('a') || titleEl.querySelector('a');
		if (!a) return;
		let href = a.href || '';
		// Google may wrap result links in /url?q=<real-url> (cookie-less/flagged
		// traffic); normal logged-in traffic gets direct links — handle both.
		if (/google\.com\/url\?/.test(href)) {
			const m = href.match(/[?&](?:q|url)=([^&]+)/);
			if (m) {
				try {
					const decoded = decodeURIComponent(m[1]);
					if (decoded.startsWith("http")) href = decoded;
				} catch {
					// keep the redirect URL
				}
			}
		}
		// Bing wraps results in /ck/a?u=<base64url> redirects — recover the real
		// URL. u is "a1" + base64url(URL); try plain first, then without the a1.
		if (/bing\.com\/ck\//.test(href)) {
			const m = href.match(/[?&]u=([^&]+)/);
			if (m) {
				for (const candidate of [m[1], m[1].replace(/^a1/, "")]) {
					try {
						const b64 = candidate.replace(/-/g, "+").replace(/_/g, "/");
						const decoded = decodeURIComponent(atob(b64));
						if (decoded.startsWith("http")) {
							href = decoded;
							break;
						}
					} catch {
						// try next candidate
					}
				}
			}
		}
		const title = (titleEl.textContent || '').trim();
		if (!title || !href.startsWith('http') || seen.has(href) || isAd(titleEl, a)) return;
		// Skip the engine's own pages (local packs / "more results").
		if (/google\.com\/search|bing\.com\/search|baidu\.com\/s|yandex\.com\/search/.test(href)) return;
		seen.add(href);
		let snippet = '';
		let n = titleEl;
		for (let i = 0; i < 4 && n; i++) {
			n = n.parentElement;
			if (!n) break;
			const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
			if (t.length > title.length) { snippet = t.slice(0, 300); break; }
		}
		out.push({ title, url: href, snippet });
	};
	document.querySelectorAll('h3, h2').forEach(push);
	return JSON.stringify(out);
})()
`;

function parseResults(raw: string): SearchResultItem[] {
	try {
		const parsed = JSON.parse(raw) as SearchResultItem[];
		return parsed.filter((r) => r.url && r.title);
	} catch {
		throw new Error("real-browser channel: could not parse search results from page");
	}
}

/** Build a direct engine search URL (query + locale + recency as params). */
function buildSearchUrl(params: WebSearchParams, engine: EngineId, recencyParam?: string): string {
	const { url, localeParams } = engineSearchUrl(engine, params.locale, recencyParam);
	const searchParams = new URLSearchParams();
	for (const [k, v] of Object.entries(localeParams ?? {})) searchParams.set(k, v);
	// Translate the structured domain filters into engine operator syntax
	// (SPEC: bsk → site: / -site:).
	let query = params.query;
	for (const d of params.allowed_domains ?? []) query += ` site:${d}`;
	for (const d of params.blocked_domains ?? []) query += ` -site:${d}`;
	return url.replace("{q}", encodeURIComponent(query)) + (searchParams.size ? `&${searchParams}` : "");
}

export async function searchWithBsk(
	params: WebSearchParams,
	engine: EngineId,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	const timeoutMs = ctx.timeoutMs ?? 30_000;
	// Direct navigation to the engine search URL: query + locale + recency
	// as URL params (precise, no DOM dependence).
	const recencyParam = params.recency
		? engine === "google"
			? `qdr:${params.recency[0]}`
			: engine === "bing"
				? params.recency
				: undefined
		: undefined;

	const results = await engineQueues[engine].run(async (sessionId) => {
		const nav = await runBsk(
			["navigate", "--session", sessionId, buildSearchUrl(params, engine, recencyParam)],
			timeoutMs,
		);
		if (!nav.ok) throw new Error(`real-browser channel: navigate ${engine} failed: ${nav.stderr}`);
		const raw = await evaluate(sessionId, EXTRACT_SCRIPT, timeoutMs);
		const results = parseResults(raw);
		if (results.length === 0) {
			// Empty extraction may mean a captcha/anti-bot wall rather than
			// genuinely no results — surface it instead of silently returning 0.
			const probe = await evaluate(
				sessionId,
				`JSON.stringify({ url: location.href, text: document.body ? document.body.innerText.slice(0, 200) : "" })`,
				timeoutMs,
			);
			let state: { url: string; text: string } = { url: "", text: "" };
			try {
				state = JSON.parse(probe) as { url: string; text: string };
			} catch {
				// keep defaults
			}
			if (/captcha|not a robot|automated requests/i.test(`${state.url} ${state.text}`)) {
				throw new Error(`real-browser channel: ${engine} blocked with a captcha challenge`);
			}
		}
		return results;
	});

	return { results, total: results.length };
}
