/**
 * pi-web-tools — installed-browser knowledge, single-sourced.
 *
 * One consumer probes the machine: bsk launches one of these for its
 * search/fetch sessions.
 *
 * Linux binary names only: macOS launches via `open -a <app>` and Windows
 * PATH lookups live with their platform code (search/browser.ts).
 */

/** Per-family candidates in preference order · a family whose binary
 *  reports Chrome-shaped versions shares the chrome entry (e.g. brave). */
const BROWSER_FAMILY_BINARIES = {
	chromium: ["chromium", "chromium-browser"],
	chrome: ["google-chrome", "google-chrome-stable", "chrome", "/opt/google/chrome/chrome", "brave-browser"],
	edge: ["microsoft-edge", "microsoft-edge-stable"],
	firefox: ["firefox", "firefox-esr"],
} as const;

/** Chromium-capable binaries flattened in preference order (launch). */
export const CHROMIUM_BINARIES: readonly string[] = [
	...BROWSER_FAMILY_BINARIES.chromium,
	...BROWSER_FAMILY_BINARIES.chrome,
	...BROWSER_FAMILY_BINARIES.edge,
];
