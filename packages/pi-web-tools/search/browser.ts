/**
 * pi-web-tools — real-browser channel (BrowserSkill / bsk CLI).
 *
 * Drives the user's real, logged-in Chromium browser (SPEC: 真实浏览器通道):
 *   - detects the bsk CLI + a connected browser
 *   - auto-launches a Chromium-family browser when none is connected
 *   - starts a session, navigates to the engine search URL, extracts results
 *     by evaluating a small script in the page.
 *
 * bsk errors are surfaced as-is (SPEC: bsk 运行报错透传到 TUI；安装归 bsk 自己).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMutex, type Mutex } from "../rate-limit.js";
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

// One browser engine at a time: concurrent navigations of the same engine
// would fight over the same tab (SPEC: bsk 真实浏览器通道).
const engineMutexes: Record<EngineId, Mutex> = {
	google: createMutex(),
	bing: createMutex(),
	baidu: createMutex(),
	yandex: createMutex(),
};

export function isBskInstalled(): boolean {
	return true; // availability is checked at runtime via `bsk status` (daemon may be missing)
}

/** Result of a bsk CLI invocation: stdout trimmed (or null when the command failed). */
async function runBsk(args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

interface BskBrowsersEntry {
	id: string;
	label?: string;
	browser?: string;
	name?: string;
}

async function connectedBrowsers(): Promise<BskBrowsersEntry[]> {
	const { ok, stdout } = await runBsk(["browsers", "--json"]);
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
		const names = ["chrome", "msedge", "brave", "chromium", "arc"];
		return names.map((n) => ({ name: n, args: [] }));
	}
	// linux
	const names = [
		"chromium",
		"chromium-browser",
		"google-chrome",
		"google-chrome-stable",
		"microsoft-edge",
		"brave-browser",
	];
	return names.map((n) => ({ name: n, args: [] }));
}

/** Try to launch a browser; returns true if any candidate started. */
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

/**
 * Ensure a browser is connected: poll `bsk browsers`, auto-launch once when
 * nothing is connected, then keep polling until timeout.
 */
export async function ensureBrowserConnected(timeoutMs = 15_000): Promise<{ ok: boolean; detail: string }> {
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

async function startSession(): Promise<{ ok: boolean; sessionId?: string; detail: string }> {
	const { ok, stdout } = await runBsk(["session", "start", "--json"]);
	if (!ok) return { ok: false, detail: "bsk session start failed" };
	try {
		const parsed = JSON.parse(stdout) as { sessionId?: string; session_id?: string; id?: string };
		const sessionId = parsed.sessionId ?? parsed.session_id ?? parsed.id;
		if (sessionId) return { ok: true, sessionId, detail: "session started" };
	} catch {
		// fall through
	}
	// Accept the raw stdout as the session id when not JSON.
	return stdout
		? { ok: true, sessionId: stdout, detail: "session started" }
		: { ok: false, detail: "bsk session start returned no id" };
}

/** Evaluate a JS expression in the session, returning trimmed stdout. */
async function evaluate(sessionId: string, expression: string, ctx: ChannelSearchContext): Promise<string> {
	const { ok, stdout, stderr } = await runBsk(
		["evaluate", "--session", sessionId, expression],
		ctx.timeoutMs ?? 30_000,
	);
	if (!ok) throw new Error(`bsk evaluate failed: ${stderr || stdout || "unknown error"}`);
	return stdout;
}

/** Extract search results from the page (engine-agnostic: h3-wrapped titles). */
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

export async function searchWithBsk(
	params: WebSearchParams,
	engine: EngineId,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	return engineMutexes[engine].run(() => searchWithBskInner(params, engine, ctx));
}

async function searchWithBskInner(
	params: WebSearchParams,
	engine: EngineId,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	// 1. browser connection
	const conn = await ensureBrowserConnected();
	if (!conn.ok) {
		throw new Error(`real-browser channel unavailable: ${conn.detail}`);
	}

	// 2. session
	const session = await startSession();
	if (!session.ok || !session.sessionId) {
		throw new Error(`real-browser channel: ${session.detail}`);
	}

	// 3. navigate to the engine search URL
	const { url, localeParams } = engineSearchUrl(engine, params.locale);
	const searchParams = new URLSearchParams();
	for (const [k, v] of Object.entries(localeParams ?? {})) searchParams.set(k, v);
	const target = url.replace("{q}", encodeURIComponent(params.query)) + (searchParams.size ? `&${searchParams}` : "");
	const nav = await runBsk(["navigate", "--session", session.sessionId, target], ctx.timeoutMs ?? 30_000);
	if (!nav.ok) {
		throw new Error(`real-browser channel: navigate failed: ${nav.stderr || "unknown error"}`);
	}

	// 4. extract results
	const raw = await evaluate(session.sessionId, EXTRACT_SCRIPT, ctx);
	let results: SearchResultItem[] = [];
	try {
		results = JSON.parse(raw) as SearchResultItem[];
	} catch {
		throw new Error(`real-browser channel: could not parse search results from page`);
	}
	results = results.filter((r) => r.url && r.title);

	// 5. cleanup session
	await runBsk(["session", "stop", "--session", session.sessionId]);

	return { results, total: results.length };
}
