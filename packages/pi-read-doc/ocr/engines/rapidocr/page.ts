/**
 * pi-read-doc — the rapidocr page reader: page images in, per-page text out.
 *
 * The page-level half of the rapidocr engine, which lives next door in
 * `engine.ts`: it runs the shipped Python bridge once for a whole batch of
 * page images (one process, one model load) and turns its JSONL into per-page
 * text. Everything version-fragile lives here and nowhere else: the engine's
 * API shape, the Python it runs under, and the confidence threshold.
 *
 * Salvage: the bridge prints a line per page as it finishes, so a run that hits
 * the wall still yields the pages it completed — the rest are reported as
 * unread rather than silently dropped.
 *
 * The contract below is NOT a cross-module port: its only consumer is the
 * rapidocr engine. It exists so that engine can be driven by fakes.
 */

import { fileURLToPath } from "node:url";
import { createRunCli, type RunCli } from "../../../run.js";

// ── The page contract (images in, per-page text out) ──────────

/** Why an OCR run produced nothing the caller can use. */
export type OcrFailure =
	/** The engine (or its Python/CLI runtime) is not installed here. */
	| "engine-missing"
	/** The run exceeded its budget. */
	| "timeout"
	/** The engine ran but failed (crash, unreadable output, …). */
	| "failed";

export interface OcrPage {
	/** Recognized text — "" when the image carried no text (a photo page). */
	text: string;
	/** Lines the confidence floor rejected. Reported so callers can tell "the
	 *  image has no text" from "the text we read was too faint to trust". */
	droppedLines?: number;
	/** Set when this page could not be read at all (engine error, or the run
	 *  ended before reaching it). Distinct from an empty page. */
	error?: string;
}

export interface OcrRunOk {
	ok: true;
	/** Per-image result, 1:1 and in the order the images were passed. */
	pages: OcrPage[];
}

export interface OcrRunErr {
	ok: false;
	reason: OcrFailure;
	/** Raw detail for diagnostics (never the user-facing hint). */
	detail?: string;
}

export interface PageOcr {
	/** Usable on this machine? Probed once and cached by the adapter. Takes the
	 *  caller's budget so a wedged probe cannot outlive the read's deadline. */
	available(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;
	/** Recognize each image, 1:1 and in order. */
	recognize(images: string[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OcrRunOk | OcrRunErr>;
	/** What the user must install to make this reader work (UI-only text). */
	installHint(): string;
}

// ── The bridge client ─────────────────────────────────────────

/** Below this recognition confidence a line is dropped (engine noise). */
export const DEFAULT_TEXT_SCORE = 0.5;
/**
 * Budget for one batch when the caller names none: interpreter start plus model
 * load (~0.8s) and a few seconds per page. The recover step always passes what
 * is left of its own deadline instead, so this is the standalone default.
 */
const STARTUP_MS = 20_000;
/** Probe budget: an import check is fast; a hang means "not usable". */
const PROBE_TIMEOUT_MS = 10_000;

const PYTHONS = ["python3", "python"];

export const RAPIDOCR_HINT =
	"Local OCR needs the rapidocr Python package: pip install rapidocr (models download on the first OCR run, then it works offline)";

/** One line of the bridge's JSONL. */
export interface OcrBridgeLine {
	n: number;
	lines?: string[];
	scores?: number[];
	error?: string;
}

/** Parse the bridge's output — garbage lines are ignored, never guessed at. */
export function parseOcrOutput(stdout: string): OcrBridgeLine[] {
	const out: OcrBridgeLine[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as OcrBridgeLine;
			if (typeof parsed.n === "number") out.push(parsed);
		} catch {
			/* a half-written line at the kill boundary — drop it */
		}
	}
	return out;
}

/** Keep the lines at or above the confidence floor, in recognition order. */
export function keepConfident(line: OcrBridgeLine, minScore: number): string[] {
	const texts = line.lines ?? [];
	const scores = line.scores ?? [];
	return texts.filter((_, i) => (scores[i] ?? 1) >= minScore);
}

export interface RapidOcrDeps {
	run: RunCli;
	/** Test seams: the bridge path and the confidence floor. */
	scriptPath?: string;
	textScore?: number;
}

export function createRapidOcr(deps: RapidOcrDeps): PageOcr {
	// NOT `rapidocr.py`: Python puts the script's own directory on sys.path[0],
	// so a file named after the module imports itself (circular import, script
	// dies). Fakes never catch this — the opt-in integration test did.
	const script = deps.scriptPath ?? fileURLToPath(new URL("./bridge.py", import.meta.url));
	const minScore = deps.textScore ?? DEFAULT_TEXT_SCORE;
	/** The interpreter that answered the probe (null = none did). */
	let interpreter: string | null | undefined;

	async function findInterpreter(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
		if (interpreter !== undefined) return interpreter;
		for (const bin of PYTHONS) {
			// Import check only: it answers "is the engine installed here", which
			// is the question the hint depends on. Whether an image can be read
			// is the run's business.
			const res = await deps.run(bin, ["-c", "import rapidocr"], {
				timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
				signal: opts.signal,
			});
			if (res.code === 0) {
				interpreter = bin;
				return interpreter;
			}
			// A probe killed by the budget or by Esc says nothing about whether
			// the engine is installed — caching that as "missing" would tell the
			// user to install what they already have, for the rest of the session.
			if (res.timedOut || opts.signal?.aborted) return null;
		}
		interpreter = null; // every interpreter answered, and none has rapidocr
		return null;
	}

	return {
		installHint: () => RAPIDOCR_HINT,

		async available(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
			return (await findInterpreter(opts)) !== null;
		},

		async recognize(images, opts = {}): Promise<OcrRunOk | OcrRunErr> {
			if (images.length === 0) return { ok: true, pages: [] };
			const bin = await findInterpreter();
			if (bin === null) return { ok: false, reason: "engine-missing" };

			// One process for the batch: the model load (~0.8s) is paid once, not
			// per page. The budget scales with the batch; start-up is slack.
			const timeoutMs = opts.timeoutMs ?? STARTUP_MS;
			const res = await deps.run(bin, [script, ...images], { timeoutMs, signal: opts.signal });

			const byIndex = new Map(parseOcrOutput(res.stdout).map((line) => [line.n, line]));
			const pages: OcrPage[] = images.map((_, i) => {
				const line = byIndex.get(i);
				if (!line) {
					// No line: the run died before reaching this page.
					return { text: "", error: res.timedOut ? "timeout" : "not read" };
				}
				if (line.error) return { text: "", error: line.error };
				const kept = keepConfident(line, minScore);
				const dropped = (line.lines?.length ?? 0) - kept.length;
				return { text: kept.join("\n"), ...(dropped > 0 ? { droppedLines: dropped } : {}) };
			});

			const read = pages.filter((p) => !p.error).length;
			if (read === 0) {
				// Nothing usable: report the run, not a page — the caller's hint
				// depends on knowing whether this was a timeout or a crash. When
				// stderr says nothing, a page's own error is the only diagnosis we
				// have (the bridge writes there, e.g. "unrecognized rapidocr
				// output shape"), and without it the user is told "failed" only.
				const reason = res.timedOut ? "timeout" : "failed";
				const firstError = pages.find((p) => p.error && p.error !== "not read")?.error;
				const detail = res.stderr.trim().slice(0, 300) || firstError;
				return { ok: false, reason, ...(detail ? { detail } : {}) };
			}
			return { ok: true, pages };
		},
	};
}

// ── The process-wide instance ─────────────────────────────────

/**
 * One reader for the process: its interpreter probe is worth ~0.5s and answers
 * the same thing every time, so the cache must outlive a single read. Tests
 * that want their own get it by injecting `pageOcr` into the engine.
 */
export const rapidocrPage: PageOcr = createRapidOcr({ run: createRunCli() });
