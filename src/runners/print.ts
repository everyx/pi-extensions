/**
 * PrintRunner — non‑interactive backend.
 *
 * Spawns `pi --print --no-session` and folds its `--mode json` event stream
 * into a final string. Uses `events.ts` for decoding; this class owns only
 * process lifecycle + AbortSignal wiring.
 *
 * Streams output via `onOutput` per delta.
 */

import { spawn } from "node:child_process";
import { type PrintEvent, parsePrintLine, streamToLines } from "../events.js";
import { DEFAULT_TIMEOUT_MS, type SubagentOptions, type SubagentResult } from "./types.js";

export class PrintRunner {
	async execute(task: string, options: SubagentOptions): Promise<SubagentResult> {
		return new Promise((resolve, reject) => {
			const args = ["--mode", "json", "-p", "--no-session"];
			if (options.model) args.push("--model", options.model);
			if (options.tools) args.push("--tools", options.tools.join(","));
			args.push(task);

			const proc = spawn("pi", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });

			const { push, close, lines } = streamToLines();
			let stderr = "";
			let finalText = "";
			let apiError = "";

			const onEvent = (evt: PrintEvent | null) => {
				if (!evt) return;
				if (evt.kind === "delta") {
					finalText += evt.text;
					options.onOutput?.(finalText);
				} else if (evt.kind === "final") {
					finalText = evt.text; // agent_end is authoritative
					options.onOutput?.(finalText);
				} else if (evt.kind === "error") {
					apiError = evt.message;
				}
			};

			const consumer = (async () => {
				for await (const line of lines) {
					onEvent(parsePrintLine(line));
				}
			})();

			proc.stdout.on("data", (d: Buffer) => push(d));
			proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

			const timer = setTimeout(() => {
				proc.kill("SIGTERM");
				reject(new Error("Sub‑agent timed out"));
			}, DEFAULT_TIMEOUT_MS);

			const abort = () => {
				clearTimeout(timer);
				proc.kill("SIGTERM");
			};
			if (options.signal?.aborted) {
				abort();
				reject(new Error("Aborted"));
				return;
			}
			options.signal?.addEventListener("abort", abort, { once: true });

			proc.on("error", (err) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				reject(err);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				close();

				void consumer.finally(() => {
					if (code !== 0) {
						reject(new Error(stderr.trim() || `Exit code ${code}`));
						return;
					}
					if (apiError) {
						reject(new Error(apiError));
						return;
					}
					resolve({ output: finalText || "" });
				});
			});
		});
	}
}
