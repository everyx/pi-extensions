/**
 * pi-read-doc — the one CLI runner.
 *
 * Both external tools (poppler, python + rapidocr) go through this: spawn with
 * a bounded lifetime, capture stdout/stderr, and NEVER throw on a non-zero
 * exit — the adapter decides what an exit code means. Tests inject a fake, so
 * every adapter decision (missing binary, timeout, partial output) is driven
 * without a real process.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface CliResult {
	/** Exit code; null when the process never ran (ENOENT) or was killed. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** True when our own timer killed the process. */
	timedOut?: boolean;
}

export interface RunCliOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type RunCli = (cmd: string, args: string[], opts?: RunCliOptions) => Promise<CliResult>;

export function createRunCli(): RunCli {
	return (cmd, args, opts = {}) =>
		new Promise<CliResult>((resolve) => {
			// Our own timer (not spawn's `timeout`) so a kill is distinguishable
			// from an ENOENT — the adapters report those differently.
			const child = spawn(cmd, args, { signal: opts.signal });
			let stdout = "";
			let stderr = "";
			// Decode ACROSS chunk boundaries: `chunk.toString()` per chunk turns a
			// split UTF-8 sequence into U+FFFD, which silently corrupts CJK — both
			// the OCR bridge (it writes `ensure_ascii=False`) and pdftotext text.
			const outDecoder = new StringDecoder("utf8");
			const errDecoder = new StringDecoder("utf8");
			let timedOut = false;
			let timer: NodeJS.Timeout | undefined;
			if (opts.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, opts.timeoutMs);
			}
			child.stdout?.on("data", (d: Buffer) => (stdout += outDecoder.write(d)));
			child.stderr?.on("data", (d: Buffer) => (stderr += errDecoder.write(d)));
			child.on("error", (err) => {
				if (timer) clearTimeout(timer);
				resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, ...(timedOut ? { timedOut } : {}) });
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				// Flush a trailing partial sequence (none for valid UTF-8).
				stdout += outDecoder.end();
				stderr += errDecoder.end();
				resolve({ code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
			});
		});
}
