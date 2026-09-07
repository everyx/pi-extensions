/**
 * pi-status-line — TPS / TTFT pure calculation.
 *
 * No pi dependency, no side effects — the interface is the test surface.
 *
 * Semantics (aligned with the researched consensus — see SPEC):
 *   numerator   = output + reasoning tokens. Provider-exact `usage.output`
 *     at message_end when available; otherwise a single ceil estimate on the
 *     cumulative chars (CJK/Kana/Hangul ≈ 1 token/char, other ≈ 4 chars/token).
 *     NEVER per-delta ceil: Σceil(cᵢ/4) ≥ ceil(Σcᵢ/4) inflates the sum by
 *     ~0.375 tokens/delta (measured +40% on token-aligned streams, +284% on
 *     char-level ones).
 *   denominator = wall clock firstToken → now/end — the industry decode-TPS
 *     definition (AI SDK outputTokensPerSecond; MLPerf ITL). Gaps during the
 *     generation count; TTFT is excluded and reported separately.
 *   live value  = the running average (the final's intermediate form), not an
 *     instantaneous rate — chunks are a transport artifact, an "instantaneous"
 *     client-side rate measures buffering/network, not the model.
 *   tool waits  = excluded structurally: pi emits turn_start per generation
 *     segment, so tool execution falls between turns (verified in
 *     pi-agent-core agent-loop).
 */

const DEBOUNCE_MS = 250;
const CHARS_PER_TOKEN = 4;

/** CJK unified ideographs, ext A, kana, compat ideographs, Hangul — these cost
 *  ~1 token per char (cl100k/o200k ≈ 1.1–1.6 chars/token), not 4. */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function countCjkChars(text: string): number {
	let n = 0;
	for (const ch of text) if (CJK_RE.test(ch)) n++;
	return n;
}

/** Token estimate for a full text — single ceil, CJK-aware. */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	const cjk = countCjkChars(text);
	return Math.ceil(cjk + (text.length - cjk) / CHARS_PER_TOKEN);
}

export function formatTps(tps: number): string {
	if (tps >= 100) return `${tps.toFixed(0)}T/s`;
	return `${tps.toFixed(1)}T/s`;
}

export function formatTtft(ms: number): string {
	if (ms >= 1000) return `T${(ms / 1000).toFixed(1)}s`;
	return `T${ms}ms`;
}

/** Session-level TTFT average — sum/count, no debounce. */
export class TtftAvg {
	totalMs = 0;
	count = 0;

	push(ms: number): void {
		this.totalMs += ms;
		this.count++;
	}

	get avgMs(): number | null {
		if (this.count === 0) return null;
		return this.totalMs / this.count;
	}

	clear(): void {
		this.totalMs = 0;
		this.count = 0;
	}
}

/** Per-turn decode state — one instance lives for the current generation. */
export class TurnMetrics {
	turnStartMs: number | null = null;
	firstTokenMs: number | null = null;
	totalChars = 0;
	totalCjkChars = 0;

	startTurn(now: number): void {
		this.turnStartMs = now;
		this.firstTokenMs = null;
		this.totalChars = 0;
		this.totalCjkChars = 0;
	}

	/** Accumulate chars only — tokens are estimated ONCE on the running total. */
	addDelta(text: string, now: number): void {
		if (text.length === 0) return;
		if (this.firstTokenMs === null) this.firstTokenMs = now;
		this.totalCjkChars += countCjkChars(text);
		this.totalChars += text.length;
	}

	get ttftMs(): number | null {
		if (this.turnStartMs === null || this.firstTokenMs === null) return null;
		return this.firstTokenMs - this.turnStartMs;
	}

	/** Estimated tokens for the generation so far — one ceil, no per-delta inflation. */
	get estimatedTokens(): number {
		return Math.ceil(this.totalCjkChars + (this.totalChars - this.totalCjkChars) / CHARS_PER_TOKEN);
	}

	#rate(now: number, exactTokens?: number): number | null {
		if (this.firstTokenMs === null) return null;
		const elapsed = now - this.firstTokenMs;
		if (elapsed < DEBOUNCE_MS) return null;
		const tokens = exactTokens && exactTokens > 0 ? exactTokens : this.estimatedTokens;
		if (tokens <= 0) return null;
		return tokens / (elapsed / 1000);
	}

	/** Live TPS — the running average over the generation so far: the final's
	 *  intermediate form. Gaps count, TTFT excluded, <250ms debounced. */
	liveTps(now: number): number | null {
		return this.#rate(now);
	}

	/** Completed-turn TPS — same formula; prefers the provider's exact output
	 *  tokens when available, falls back to the estimate. */
	averageTps(now: number, exactTokens?: number): number | null {
		return this.#rate(now, exactTokens);
	}

	clear(): void {
		this.turnStartMs = null;
		this.firstTokenMs = null;
		this.totalChars = 0;
		this.totalCjkChars = 0;
	}
}
