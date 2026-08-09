/**
 * pi-ui — theme resolution for preview scripts.
 *
 * pi's live theme object lives in an internal module the package entry
 * doesn't re-export and whose subpath is blocked by its "exports" map.
 * These helpers walk node_modules physically and import the file by
 * absolute URL, bypassing the exports map entirely.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

/** Find a package's install directory by walking up from the caller. */
export function findPkgDir(name: string, from = import.meta.dirname): string | null {
	let dir = from;
	for (;;) {
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Resolve pi's live theme object (bypassing the exports map). */
export async function resolveTheme(): Promise<Theme> {
	const pkgDir = findPkgDir("@earendil-works/pi-coding-agent");
	if (!pkgDir) throw new Error("pi-coding-agent not found under node_modules");
	const themeModulePath = path.join(pkgDir, "dist", "modes", "interactive", "theme", "theme.js");
	const { theme: globalTheme } = (await import(pathToFileURL(themeModulePath).href)) as { theme: Theme };
	return globalTheme as Theme;
}

/** Init a theme by name and return the live theme object (for previews). */
export async function initPreviewTheme(themeName = process.env.THEME || "light"): Promise<Theme> {
	initTheme(themeName);
	return resolveTheme();
}
