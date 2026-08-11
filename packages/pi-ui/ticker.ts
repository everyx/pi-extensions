/**
 * pi-ui — unified animation ticker.
 *
 * Problem: TUI rendering is event-driven (a component redraws when its
 * content changes), but a spinner needs clock-driven redraws at a steady
 * cadence. If every animated component owned its own setInterval, cadences
 * would drift apart and the outer redraw rate could never match the fastest
 * internal animation — the stutter that keeps coming back.
 *
 * Design: components register their animation interval; the ticker runs a
 * single setInterval at the smallest registered interval and calls every
 * callback on each tick — the outer redraw rate is exactly the fastest
 * internal animation need. No subscribers → no timer. The timer is unref'd
 * so a leftover subscription can never keep the process alive.
 */

import { SPINNER_TICK_MS } from "./spinner.js";

export interface TickerHandle {
	/** Stop this subscription (idempotent). */
	unsubscribe(): void;
}

interface Entry {
	cb: () => void;
	intervalMs: number;
}

class Ticker {
	private readonly entries = new Map<object, Entry>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private cadenceMs: number | undefined;

	/** Subscribe a callback to the unified animation cadence. */
	subscribe(cb: () => void, intervalMs: number = SPINNER_TICK_MS): TickerHandle {
		const key = {};
		this.entries.set(key, { cb, intervalMs });
		this.resync();
		let done = false;
		return {
			unsubscribe: () => {
				if (done) return;
				done = true;
				this.entries.delete(key);
				this.resync();
			},
		};
	}

	/** Live subscriber count — diagnostics (and tests). */
	get subscriberCount(): number {
		return this.entries.size;
	}

	private resync(): void {
		let min: number | undefined;
		for (const { intervalMs } of this.entries.values()) {
			if (min === undefined || intervalMs < min) min = intervalMs;
		}
		if (min === undefined) {
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
				this.cadenceMs = undefined;
			}
			return;
		}
		if (this.timer && this.cadenceMs === min) return;
		if (this.timer) clearInterval(this.timer);
		this.cadenceMs = min;
		this.timer = setInterval(() => this.tick(), min);
		// A live animation must never keep the host process alive.
		this.timer.unref?.();
	}

	private tick(): void {
		for (const { cb } of this.entries.values()) {
			try {
				cb();
			} catch {
				// One broken callback must not kill the other animations.
			}
		}
	}
}

/** Process-wide singleton — every pi-ui consumer shares one animation clock. */
export const ticker = new Ticker();
