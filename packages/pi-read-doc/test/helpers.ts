/**
 * Shared test seam: a scripted CLI runner.
 *
 * Both adapters (poppler, rapidocr) take a RunCli; this fake records the calls
 * and returns what the case dictates, so every adapter decision — missing
 * binary, timeout, partial output — is driven without a real process.
 */

import type { CliResult, RunCli } from "../run.js";

export function fakeRun(script: (cmd: string, args: string[]) => Partial<CliResult> = () => ({})) {
	const calls: { cmd: string; args: string[] }[] = [];
	const run: RunCli = async (cmd, args) => {
		calls.push({ cmd, args });
		const r = script(cmd, args);
		// `code: null` is meaningful (ENOENT / killed) — only `undefined` defaults.
		return {
			code: r.code === undefined ? 0 : r.code,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			...(r.timedOut ? { timedOut: true } : {}),
		};
	};
	return { run, calls };
}
