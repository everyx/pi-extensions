/**
 * pi-ui — dev-only storybook runtime for extension previews.
 *
 * Never imported by production code. Both extension previews (pi-subagent,
 * pi-web-tools) render through this module so the theme-loading hack, the
 * framework-shell simulation, and line rendering have exactly one
 * implementation — storybooks stay honest mirrors of the real cards.
 *
 * The theme is loaded by deep-importing pi's interactive theme module from
 * node_modules (it is not part of any public export surface — that is why
 * this hack exists and why it lives here, once).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";

function findPkgDir(name: string): string | null {
	let dir = import.meta.dirname;
	for (;;) {
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export type ShellBg = "toolSuccessBg" | "toolErrorBg" | "toolPendingBg";

export interface PreviewRuntime {
	theme: Theme;
	renderLines(component: unknown, width?: number): string[];
	/** Simulate pi's framework tool shell (tool-execution.js default shell):
	 *  a Box(1,1) whose background follows tool state, covering header + body. */
	toolShell(bg: ShellBg, children: unknown[], w?: number): string[];
}

export async function createPreviewRuntime(): Promise<PreviewRuntime> {
	const pkgDir = findPkgDir("@earendil-works/pi-coding-agent");
	if (!pkgDir) throw new Error("pi-coding-agent not found under node_modules");
	const themeModulePath = path.join(pkgDir, "dist", "modes", "interactive", "theme", "theme.js");
	const { theme: globalTheme } = (await import(pathToFileURL(themeModulePath).href)) as { theme: Theme };
	const theme = globalTheme as Theme;

	function renderLines(component: unknown, width = 100): string[] {
		const c = component as { render(w: number): string[] };
		return c.render(width);
	}

	return {
		theme,
		renderLines,
		toolShell(bg: ShellBg, children: unknown[], w = 100): string[] {
			const box = new Box(1, 1, (t: string) => theme.bg(bg, t));
			for (const child of children) box.addChild(child as never);
			return renderLines(box, w);
		},
	};
}
