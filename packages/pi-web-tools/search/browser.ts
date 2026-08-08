/**
 * pi-web-tools — real-browser channel (BrowserSkill / bsk CLI).
 *
 * Drives the user's real, logged-in Chromium browser (SPEC: 真实浏览器通道).
 * To behave like a human (anti-bot friendly), searches go through the real
 * input path: open the engine home page, type the query into the search box,
 * press Enter, wait for navigation, extract results. Structured filters that
 * map to engine URL params (recency) use the direct search-URL path instead;
 * if the search box is not found, we fall back to the search-URL path.
 *
 * Per-engine serial queues share one bsk session across a burst of queued
 * searches (SPEC: 批量搜索一次打开浏览器，存结果，继续下一个，再返回结束).
 * bsk errors surface as-is (SPEC: bsk 运行报错透传到 TUI；安装归 bsk 自己).
 *
 * Follows BrowserSkill's mandatory lifecycle: session start → commands with
 * --session → session stop (always, even on error paths).
 */

import { execFile } from "node:child_process";
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

/** Engine home pages (human path: navigate → type → search). */
const ENGINE_HOME: Record<EngineId, string> = {
	google: "https://www.google.com",
	bing: "https://www.bing.com",
	baidu: "https://www.baidu.com",
	yandex: "https://yandex.com",
};

/** Search-box CSS selectors per engine (home pages). */
const SEARCH_BOX_SELECTOR: Record<EngineId, string> = {
	google: 'textarea[name="q"], input[name="q"]',
	bing: 'input[name="q"], textarea[name="q"]',
	baidu: 'input[name="wd"], input#kw',
	yandex: 'input[name="text"], input#text',
};

// One serial queue per engine: a burst of queued searches shares a single
// bsk session (open lazily, close when the queue drains).
const engineQueues: Record<EngineId, SerialQueue<string>> = {
	google: createSerialQueue(openSession, closeSession),
	bing: createSerialQueue(openSession, closeSession),
	baidu: createSerialQueue(openSession, closeSession),
	yandex: createSerialQueue(openSession, closeSession),
};

// ── bsk CLI plumbing ─────────────────────────────────────────────

interface BskResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function runBsk(args: string[], timeoutMs = 30_000): Promise<BskResult> {
	try {
		const { stdout, stderr } = await execFileAsync(BSK, args, {
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
		return list.filter((b) => b?.id || b?.browser || b?.name);
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
			await execFileAsync(candidate.name, candidate.args, { timeout: 5_000 });
			return true;
		} catch {
			// try next candidate
		}
	}
	return false;
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
	if (!ok) throw new Error(`bsk session start failed`);
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
}

// ── search execution ─────────────────────────────────────────────

/** Evaluate a JS expression in the session, returning trimmed stdout. */
async function evaluate(sessionId: string, expression: string, timeoutMs: number): Promise<string> {
	const { ok, stdout, stderr } = await runBsk(["evaluate", "--session", sessionId, expression], timeoutMs);
	if (!ok) throw new Error(`bsk evaluate failed: ${stderr || stdout || "unknown error"}`);
	return stdout;
}

/** Extract search results from the page (engine-agnostic: h2/h3-wrapped titles). */
const EXTRACT_SCRIPT = String.raw`
(() => {
	const out = [];
	const seen = new Set();
	const push = (titleEl) => {
		const a = titleEl.closest('a') || titleEl.querySelector('a');
		if (!a) return;
		const href = a.href || '';
		const title = (titleEl.textContent || '').trim();
		if (!title || !href.startsWith('http') || seen.has(href)) return;
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

/** Build a direct engine search URL (fallback / structured-filter path). */
function buildSearchUrl(params: WebSearchParams, engine: EngineId, recencyParam?: string): string {
	const { url, localeParams } = engineSearchUrl(engine, params.locale, recencyParam);
	const searchParams = new URLSearchParams();
	for (const [k, v] of Object.entries(localeParams ?? {})) searchParams.set(k, v);
	return url.replace("{q}", encodeURIComponent(params.query)) + (searchParams.size ? `&${searchParams}` : "");
}

/** Human path: home page → type into search box → Enter → wait → extract. */
async function searchHumanPath(
	sessionId: string,
	params: WebSearchParams,
	engine: EngineId,
	timeoutMs: number,
): Promise<SearchResultItem[]> {
	const home = ENGINE_HOME[engine];
	const nav = await runBsk(["navigate", "--session", sessionId, home, "--wait-until", "load"], timeoutMs);
	if (!nav.ok) throw new Error(`real-browser channel: navigate ${home} failed: ${nav.stderr || "unknown error"}`);

	const selector = SEARCH_BOX_SELECTOR[engine];
	const fill = await runBsk(
		["fill", "--session", sessionId, "--selector", selector, "--value", params.query],
		timeoutMs,
	);
	if (!fill.ok) {
		// Search box not found (engine DOM changed) — fall back to the
		// direct search-URL path rather than failing the search.
		const target = buildSearchUrl(params, engine);
		const nav2 = await runBsk(["navigate", "--session", sessionId, target], timeoutMs);
		if (!nav2.ok) throw new Error(`real-browser channel: navigate ${engine} failed: ${nav2.stderr}`);
	} else {
		const press = await runBsk(["press", "--session", sessionId, "Enter"], timeoutMs);
		if (!press.ok) throw new Error(`real-browser channel: press Enter failed: ${press.stderr}`);
		await runBsk(["wait-for-navigation", "--session", sessionId], timeoutMs);
	}

	const raw = await evaluate(sessionId, EXTRACT_SCRIPT, timeoutMs);
	return parseResults(raw);
}

export async function searchWithBsk(
	params: WebSearchParams,
	engine: EngineId,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	const timeoutMs = ctx.timeoutMs ?? 30_000;
	// Structured recency filters map to engine URL params (tbs/mkt); the
	// human path can't express them, so those go through the search-URL path.
	const recencyParam = params.recency
		? engine === "google"
			? `qdr:${params.recency[0]}`
			: engine === "bing"
				? params.recency
				: undefined
		: undefined;

	const results = await engineQueues[engine].run(async (sessionId) => {
		if (recencyParam) {
			const nav = await runBsk(
				["navigate", "--session", sessionId, buildSearchUrl(params, engine, recencyParam)],
				timeoutMs,
			);
			if (!nav.ok) throw new Error(`real-browser channel: navigate ${engine} failed: ${nav.stderr}`);
			const raw = await evaluate(sessionId, EXTRACT_SCRIPT, timeoutMs);
			return parseResults(raw);
		}
		return searchHumanPath(sessionId, params, engine, timeoutMs);
	});

	return { results, total: results.length };
}
