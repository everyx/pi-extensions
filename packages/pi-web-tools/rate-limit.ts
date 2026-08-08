/**
 * pi-web-tools — per-provider request throttling.
 *
 * Providers declare their qps (requests per second) limit; createRateLimiter
 * serializes calls with a minimum interval of 1000/qps ms. No qps = unlimited
 * (calls pass through untouched — no unnecessary serialization).
 *
 * Researched limits:
 *   - Exa MCP (keyless): 3 qps (150 calls/day)
 *   - Tavily free tier:  1 qps, account-level
 *   - Parallel:          600 RPM (10 qps)
 *   - Exa REST (key):    credit-metered, qps not published — left unlimited
 */

export interface RateLimiter {
	/** Run fn under this limiter's throttle (pass-through when unlimited). */
	run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * A mutual-exclusion queue: one call runs at a time, the rest wait in order,
 * with no extra interval between calls. Use for resources that cannot be
 * touched concurrently (e.g. driving the same browser engine via bsk).
 */
export interface Mutex {
	run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutex(): Mutex {
	let tail: Promise<void> = Promise.resolve();
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const result = tail.then(() => fn());
			// Keep the queue alive even when a call fails.
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	};
}

export function createRateLimiter(qps?: number): RateLimiter {
	const minIntervalMs = qps && qps > 0 ? 1000 / qps : 0;
	if (!minIntervalMs) {
		// Unlimited: pass through untouched.
		return { run: (fn) => fn() };
	}

	let chain: Promise<void> = Promise.resolve();
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const run = chain.then(async () => {
				const result = await fn();
				await sleep(minIntervalMs);
				return result;
			});
			// Keep the chain alive even when a call fails.
			chain = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
