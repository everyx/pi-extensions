/**
 * pi-web-tools — UA resolution (SPEC: UA 策略).
 *
 * Prefer the *system default browser*: detect it (xdg on Linux), read its
 * real version via `--version` (fast, no headless startup), and build the
 * standard UA string for that engine. Falls back to probing any installed
 * Chrome-family / Firefox binary, then to a hardcoded modern UA.
 *
 * Why not other routes (all explored & rejected):
 *   - bsk evaluate: unreliable in practice.
 *   - Chrome --headless --repl: removed in modern Chrome.
 *   - Chrome --headless --dump-dom: works, but the UA carries the
 *     "HeadlessChrome" marker and ignores the default browser.
 *   - Firefox headless HTTP-sniff: needs a local listener + slow startup.
 *   - get_user_agent approach (scraping whatismybrowser.com): now 403.
 *
 * Building from --version gives a real, current version with no headless
 * marker and no network dependency; the platform segment is a per-OS
 * template (the browser+version is what anti-bot checks key on).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BrowserId = "firefox" | "chrome" | "chromium" | "edge" | "unknown";

/** Binary names to probe per browser family (first that exists wins). */
const BROWSER_BINARIES: Record<Exclude<BrowserId, "unknown">, string[]> = {
	firefox: ["firefox", "firefox-esr"],
	chrome: ["google-chrome", "google-chrome-stable", "/opt/google/chrome/chrome"],
	chromium: ["chromium", "chromium-browser"],
	edge: ["microsoft-edge", "microsoft-edge-stable"],
};

/** Map a .desktop id / binary name to a browser family. */
export function browserIdFromName(name: string): BrowserId {
	const n = name.toLowerCase();
	if (n.includes("firefox")) return "firefox";
	if (n.includes("chromium")) return "chromium";
	if (n.includes("google-chrome") || n === "chrome") return "chrome";
	if (n.includes("edge")) return "edge";
	return "unknown";
}

/** OS platform segment for the UA templates. */
function platformSegment(platform: NodeJS.Platform): { chrome: string; firefox: string } {
	if (platform === "darwin") {
		return { chrome: "Macintosh; Intel Mac OS X 10_15_7", firefox: "Macintosh; Intel Mac OS X 10.15" };
	}
	if (platform === "win32") {
		return { chrome: "Windows NT 10.0; Win64; x64", firefox: "Windows NT 10.0; Win64; x64" };
	}
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	return { chrome: `X11; Linux ${arch}`, firefox: `X11; Linux ${arch}` };
}

/** Build the standard UA string for a browser family + real version. */
export function buildUserAgent(
	browser: BrowserId,
	version: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const seg = platformSegment(platform);
	switch (browser) {
		case "firefox": {
			// "Mozilla Firefox 153.0.3" → 153.0 (rv + product share the version).
			const ver = /(\d+\.\d+)/.exec(version)?.[1] ?? version;
			return `Mozilla/5.0 (${seg.firefox}; rv:${ver}) Gecko/20100101 Firefox/${ver}`;
		}
		case "chrome":
		case "chromium": {
			// "Google Chrome 122.0.6261.94" → major.0.0.0 (stable release form).
			const major = /(\d+)/.exec(version)?.[1] ?? version;
			return `Mozilla/5.0 (${seg.chrome}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
		}
		case "edge": {
			const ver = /(\d+\.\d+(?:\.\d+)*)/.exec(version)?.[1] ?? version.trim();
			const major = /(\d+)/.exec(version)?.[1] ?? version;
			return `Mozilla/5.0 (${seg.chrome}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${ver}`;
		}
		default:
			return "";
	}
}

/** Parse a `--version` stdout line into (browser, version). */
function parseVersionLine(line: string): { browser: BrowserId; version: string } | undefined {
	const browser = browserIdFromName(line);
	if (browser === "unknown") return undefined;
	const m = /(\d+\.\d+(?:\.\d+)*)/.exec(line);
	if (!m) return undefined;
	return { browser, version: m[1] };
}

/** Read `--version` from a binary; undefined when it's missing or fails. */
async function versionOf(binary: string): Promise<{ browser: BrowserId; version: string } | undefined> {
	try {
		const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 3_000 });
		return parseVersionLine((stdout || stderr).trim());
	} catch {
		return undefined;
	}
}

/** System default browser (Linux: xdg) → binary name. */
async function defaultBrowserBinary(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("xdg-settings", ["get", "default-web-browser"], { timeout: 2_000 });
		const desktop = stdout.trim().toLowerCase();
		if (!desktop.endsWith(".desktop") && !desktop.includes(".")) return undefined;
		const id = browserIdFromName(desktop);
		if (id === "unknown") return undefined;
		return BROWSER_BINARIES[id][0];
	} catch {
		return undefined;
	}
}

// Fixed fallback when no browser is installed: a commonly-used modern
// Chrome (version pinned by us, matching the current stable release).
const FALLBACK_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

let cachedUserAgent: string | null = null;
let uaFetchInFlight: Promise<string> | null = null;

/** Resolve the fetch User-Agent: default browser → any installed browser → fallback. */
export async function resolveUserAgent(): Promise<string> {
	if (cachedUserAgent) return cachedUserAgent;
	if (!uaFetchInFlight) {
		uaFetchInFlight = (async () => {
			const defaultBin = await defaultBrowserBinary();
			const probeOrder = [...(defaultBin ? [defaultBin] : []), ...Object.values(BROWSER_BINARIES).flat()];
			const seen = new Set<string>();
			for (const binary of probeOrder) {
				if (seen.has(binary)) continue;
				seen.add(binary);
				const info = await versionOf(binary);
				if (info) {
					const ua = buildUserAgent(info.browser, info.version);
					if (ua) {
						cachedUserAgent = ua;
						return ua;
					}
				}
			}
			return FALLBACK_UA;
		})();
	}
	const ua = await uaFetchInFlight;
	uaFetchInFlight = null;
	return ua;
}
