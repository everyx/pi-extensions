/**
 * pi-web-tools — update:ua script.
 *
 * Re-pins FALLBACK_UA (in fetch/ua.ts) to the market-leading browser's
 * most-used version, driven by caniuse-lite's global usage data (the same
 * source browserslist/esbuild usage rules rely on).
 *
 *   pnpm update:ua            # read current caniuse-lite snapshot
 *   pnpm update:ua --update-db  # refresh the snapshot first (see below)
 *
 * Run it before releasing. The runtime stays offline — the fallback is a
 * compiled-in constant.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { agents } from "caniuse-lite/dist/unpacker/agents.js";

const UA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fetch/ua.ts");

/** Desktop browser families in caniuse agents (mobile Chrome is and_chr). */
const DESKTOP = ["chrome", "edge", "firefox", "safari", "opera"];

/** Total global usage (%) of a browser across all versions. */
function totalUsage(name) {
	const usage = agents[name]?.usage_global ?? {};
	return Object.values(usage).reduce((a, b) => a + b, 0);
}

/** Most-used version of a browser (highest single-version usage %). */
function topVersion(name) {
	const usage = agents[name]?.usage_global ?? {};
	return Object.entries(usage).sort((a, b) => b[1] - a[1])[0];
}

const leader = DESKTOP.map((name) => ({ name, total: totalUsage(name) })).sort((a, b) => b.total - a.total)[0];
const [version, share] = topVersion(leader.name);

// Chrome-family UA, macOS platform template (kept stable across pins).
const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;

const src = readFileSync(UA_FILE, "utf8");
// Pin only the Chrome version inside the existing fallback string —
// rewriting the whole block is fragile (the UA contains semicolons).
const versionPattern = /Chrome\/\d+\.0\.0\.0/;
if (!versionPattern.test(src)) {
	console.error("update:ua — Chrome version not found in FALLBACK_UA (fetch/ua.ts)");
	process.exit(1);
}
const updated = src.replace(versionPattern, `Chrome/${version}.0.0.0`);
writeFileSync(UA_FILE, updated);

console.log(`update:ua — fallback pinned to ${leader.name} ${version} (usage ${share.toFixed(2)}%, total ${leader.total.toFixed(2)}%)`);
console.log(`  ${ua}`);
