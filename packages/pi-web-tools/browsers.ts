/**
 * pi-web-tools — installed-browser knowledge, single-sourced.
 *
 * Three consumers probe the machine for browsers: bsk search launches one,
 * headless CSR rendering drives one, and UA resolution reads its version.
 * One list means a newly installed browser becomes usable everywhere at
 * once — previously three divergent copies meant a browser could be
 * launchable for search yet invisible to rendering and UA probing.
 *
 * Linux binary names only: macOS launches via `open -a <app>` and Windows
 * PATH lookups live with their platform code (search/browser.ts).
 */

/** Per-family candidates in preference order. Keys mirror UA template
 *  families (ua.ts BrowserId); a family whose binary reports Chrome-shaped
 *  versions shares the chrome entry (e.g. brave). */
export const BROWSER_FAMILY_BINARIES = {
	chromium: ["chromium", "chromium-browser"],
	chrome: ["google-chrome", "google-chrome-stable", "chrome", "/opt/google/chrome/chrome", "brave-browser"],
	edge: ["microsoft-edge", "microsoft-edge-stable"],
	firefox: ["firefox", "firefox-esr"],
} as const;

/** Chromium-capable binaries flattened in preference order (launch / render). */
export const CHROMIUM_BINARIES: readonly string[] = [
	...BROWSER_FAMILY_BINARIES.chromium,
	...BROWSER_FAMILY_BINARIES.chrome,
	...BROWSER_FAMILY_BINARIES.edge,
];
