/**
 * pi-web-tools — where the provider keys come from.
 *
 * Two sources, in this order:
 *
 *   1. the environment (`TINYFISH_API_KEY`, …) — CI, scripts, `direnv`, and
 *      anything that already exports them;
 *   2. `<agent dir>/web-tools.json` — a flat `{ "tinyfish": "…" }` file for
 *      people who would rather not edit shell config.
 *
 * pi has no extension secret store of its own (`auth.json` belongs to LLM
 * providers), so an extension picks a convention. The two comparable pi web
 * extensions both landed on "env first, own JSON file second"; this is the
 * same shape, one file, no project-level variant — keys are per user, and a
 * `.pi/web-tools.json` would invite committing them.
 *
 * The file is read once per process and never written. A missing, unreadable,
 * or malformed file is not an error: it simply contributes nothing, which is
 * exactly the behaviour of an unset environment variable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Environment variable per provider, and the key each provider uses in the file. */
const PROVIDERS = {
	tinyfish: "TINYFISH_API_KEY",
	exa: "EXA_API_KEY",
	tavily: "TAVILY_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
} as const;

export type ProviderId = keyof typeof PROVIDERS;

/** `<agent dir>/web-tools.json`. */
export function keysFilePath(): string {
	return join(getAgentDir(), "web-tools.json");
}

/** The file's contents, or an empty map when there is no usable file.
 *
 *  Accepted shape: a flat object of provider id → key. Unknown keys are
 *  ignored rather than rejected — a file that outlives a provider should not
 *  break the ones that remain. */
export function readKeys(file: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const keys: Record<string, string> = {};
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) keys[id] = value.trim();
	}
	return keys;
}

/** One read per file per process — key files do not change mid-session. */
const fileCache = new Map<string, Record<string, string>>();

/** Drop the cached file contents (tests, and a fresh read after `/reload`). */
export function resetKeysCache(): void {
	fileCache.clear();
}

/**
 * The key for one provider, or null when neither source has it.
 *
 * Environment wins: it is the more explicit, per-invocation choice, and it is
 * the only source that exists in CI. `file` is a test seam; production callers
 * take the default.
 */
export function apiKey(provider: ProviderId, file: string = keysFilePath()): string | null {
	const fromEnv = process.env[PROVIDERS[provider]]?.trim();
	if (fromEnv) return fromEnv;
	let keys = fileCache.get(file);
	if (!keys) {
		keys = readKeys(file);
		fileCache.set(file, keys);
	}
	return keys[provider] ?? null;
}
