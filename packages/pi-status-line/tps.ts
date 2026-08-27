/**
 * pi-status-line — TPS / TTFT pure calculation.
 *
 * No pi dependency, no side effects — the interface is the test surface.
 * Industry convention (OpenCode / pi-tps-status):
 *   numerator = output + reasoning tokens (chars/4 estimate when provider
 *     counts unavailable), denominator = pure decode time
 *     (firstToken → now, tool wait excluded, <250ms debounced).
 *   TTFT = turn_start → firstToken, reported separately.
 */

const DEBOUNCE_MS = 250;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function formatTps(tps: number): string {
	if (tps >= 100) return `${tps.toFixed(0)} tok/s`;
	return `${tps.toFixed(1)} tok/s`;
}

export function formatTtft(ms: number): string {
	if (ms >= 1000) return `TTFT ${(ms / 1000).toFixed(1)}s`;
	return `TTFT ${ms}ms`;
}

/** Sliding window that sums tokens inside windowMs. */
export class SlidingWindow {
	readonly windowMs: number;
	#samples: Array<{ t: number; tokens: number }> = [];

	constructor(windowMs = 1000) {
		this.windowMs = windowMs;
	}

	push(now: number, tokens: number): void {
		this.#samples.push({ t: now, tokens });
		const cutoff = now - this.windowMs;
		while (this.#samples.length > 0 && this.#samples[0].t < cutoff) {
			this.#samples.shift();
		}
	}

	get tokens(): number {
		let sum = 0;
		for (const s of this.#samples) sum += s.tokens;
		return sum;
	}

	get spanMs(): number {
		if (this.#samples.length < 2) return 0;
		return this.#samples[this.#samples.length - 1].t - this.#samples[0].t;
	}

	clear(): void {
		this.#samples = [];
	}
}

/** Per-turn decode state — one instance lives for the current turn. */
export class TurnMetrics {
	turnStartMs: number | null = null;
	firstTokenMs: number | null = null;
	totalTokens = 0;
	readonly window = new SlidingWindow(1000);

	startTurn(now: number): void {
		this.turnStartMs = now;
		this.firstTokenMs = null;
		this.totalTokens = 0;
		this.window.clear();
	}

	/** Returns newly estimated tokens for this delta. */
	addDelta(text: string, now: number): number {
		const tokens = estimateTokens(text);
		if (tokens === 0) return 0;
		if (this.firstTokenMs === null) this.firstTokenMs = now;
		this.totalTokens += tokens;
		this.window.push(now, tokens);
		return tokens;
	}

	get ttftMs(): number | null {
		if (this.turnStartMs === null || this.firstTokenMs === null) return null;
		return this.firstTokenMs - this.turnStartMs;
	}

	/** Live TPS over the sliding window; null when debounced / insufficient data. */
	liveTps(now: number): number | null {
		if (this.firstTokenMs === null) return null;
		const elapsed = now - this.firstTokenMs;
		if (elapsed < DEBOUNCE_MS) return null;
		const span = this.window.spanMs;
		// Need at least two samples spanning some time; fall back to total/elapsed.
		if (span < 100) {
			return this.totalTokens / (elapsed / 1000);
		}
		return this.window.tokens / (span / 1000);
	}

	/** Completed-turn average: total / pure decode time. */
	averageTps(now: number): number | null {
		if (this.firstTokenMs === null || this.totalTokens === 0) return null;
		const elapsed = now - this.firstTokenMs;
		if (elapsed < DEBOUNCE_MS) return null;
		return this.totalTokens / (elapsed / 1000);
	}

	clear(): void {
		this.turnStartMs = null;
		this.firstTokenMs = null;
		this.totalTokens = 0;
		this.window.clear();
	}
}
