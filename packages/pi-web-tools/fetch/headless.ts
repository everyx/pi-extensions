/**
 * pi-web-tools — headless renderer for CSR pages (SPEC: web_fetch 行为规格).
 *
 * When a page's HTML is an empty shell (content rendered by JavaScript), we
 * render it with a local headless Chromium to hand the LLM real content
 * instead of a placeholder. Rendering itself is fast (~0.4s); wall time is
 * dominated by downloading the page's JS bundles, which is unavoidable for
 * CSR pages and capped by a timeout that kills the process.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHROMIUM_BINARIES } from "../browsers.js";

const RENDER_TIMEOUT_MS = 60_000;
const VIRTUAL_TIME_BUDGET_MS = 5_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/** Chromium-family binaries, in preference order — single-sourced (browsers.ts). */
const CANDIDATES: readonly string[] = CHROMIUM_BINARIES;

let cachedBinary: string | null | undefined;

/** First installed Chromium-family binary (cached; null = none found). */
export function findHeadlessBrowser(): string | null {
	if (cachedBinary !== undefined) return cachedBinary;
	cachedBinary = null;
	for (const name of CANDIDATES) {
		const res = spawnSync("which", [name], { encoding: "utf8" });
		const line = res.stdout?.trim().split("\n")[0];
		if (line) {
			cachedBinary = line;
			break;
		}
	}
	return cachedBinary;
}

/**
 * Render a URL with headless Chromium and return the post-JS DOM.
 * Returns null when no browser is available, rendering failed, or timed out.
 */
export function renderPage(url: string, timeoutMs = RENDER_TIMEOUT_MS): Promise<string | null> {
	const bin = findHeadlessBrowser();
	if (!bin) return Promise.resolve(null);

	return new Promise((resolve) => {
		const profile = mkdtempSync(path.join(tmpdir(), "pi-fetch-render-"));
		const proc = spawn(
			bin,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-first-run",
				`--user-data-dir=${profile}`,
				`--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
				"--dump-dom",
				url,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);

		let out = "";
		let settled = false;
		proc.stdout?.on("data", (chunk: Buffer) => {
			if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString();
		});
		const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);

		const finish = (html: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rmSync(profile, { recursive: true, force: true });
			resolve(html);
		};
		proc.on("error", () => finish(null));
		proc.on("close", (code) => finish(code === 0 || out.length > 0 ? out || null : null));
	});
}
