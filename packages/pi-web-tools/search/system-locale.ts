/**
 * pi-web-tools — system locale detection (SPEC: 系统 locale 决定启用集).
 *
 * The terminal's LANG/LC_ALL env vars can be overridden by the user's shell
 * (e.g. forcing en_US) while the actual system language is different — the
 * engine defaults should follow the *system*, not the shell. On Linux the
 * systemd `localectl status` command is the authoritative, stable query
 * interface (the underlying locale.conf layout is an implementation detail
 * that may move). Non-Linux platforms fall back to Intl (Windows reads the
 * registry user locale; macOS reads the terminal-injected LANG — both
 * correct there).
 */

import { execFileSync } from "node:child_process";

/** Parse the System Locale line from `localectl status` output
 * ("System Locale: LANG=zh_CN.UTF-8" — quotes optional, n/a when unset). */
export function localeFromLocalectl(output: string): string | undefined {
	const m = output.match(/\bLANG=([^\s"']+|"[^"]+")/);
	if (!m) return undefined;
	return m[1].replace(/^"|"$/g, "");
}

/**
 * Resolve the system locale: Linux → localectl status (sync, one call at
 * startup; falls back to Intl when localectl is missing), otherwise Intl.
 */
export function systemLocale(): string {
	if (process.platform === "linux") {
		try {
			const out = execFileSync("localectl", ["status"], { encoding: "utf8", timeout: 3_000 });
			const locale = localeFromLocalectl(out);
			if (locale) return locale;
		} catch {
			// non-systemd or localectl absent — fall through to Intl
		}
	}
	return Intl.DateTimeFormat().resolvedOptions().locale;
}
