/**
 * Shared test seam: a scripted CLI runner.
 *
 * Both adapters (poppler, rapidocr) take a RunCli; this fake records the calls
 * and returns what the case dictates, so every adapter decision — missing
 * binary, timeout, partial output — is driven without a real process.
 */

import type { Engine, EngineId, ServeContext, ServeResult } from "../convert.js";
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

/** The parser's rejection: a document with pages that need OCR. */
export function needsOcrError(
	pages: number[],
	pageCount?: number,
): Error & {
	code: string;
	pages: number[];
	pageCount: number;
} {
	const e = new Error("scanned pages need OCR") as Error & { code: string; pages: number[]; pageCount: number };
	e.code = "needsOcr";
	e.pages = pages;
	e.pageCount = pageCount ?? Math.max(...pages, 0);
	return e;
}

/** An engine that answers what the case dictates and counts being asked. */
export function fakeEngine(
	id: EngineId,
	result: ServeResult | (() => Promise<ServeResult>),
): Engine & { calls: number; contexts: ServeContext[] } {
	const e: Engine & { calls: number; contexts: ServeContext[] } = {
		id,
		calls: 0,
		contexts: [],
		async serve(ctx: ServeContext) {
			e.calls++;
			e.contexts.push(ctx);
			return typeof result === "function" ? await result() : result;
		},
	};
	return e;
}
