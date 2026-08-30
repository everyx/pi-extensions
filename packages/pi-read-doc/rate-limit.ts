/**
 * pi-read-doc — rate limiter for the hosted Parse API (2 qps).
 *
 * Serializes callers on a promise chain and spaces call starts by 1000/qps.
 * pi-web-tools has a similar rate-limit.ts, but with a per-channel queue that
 * sleeps AFTER each call — this package needs the sleep-before form, kept
 * separate to avoid a runtime dependency on pi-web-tools.
 */

export function createRateLimiter(qps: number) {
	let last = 0;
	let chain: Promise<void> = Promise.resolve();
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (qps <= 0) return fn();
		const gap = 1000 / qps;
		const task = chain.then(async () => {
			const now = Date.now();
			const wait = Math.max(0, last + gap - now);
			if (wait) await new Promise((r) => setTimeout(r, wait));
			last = Date.now();
			return fn();
		});
		chain = task.then(
			() => {},
			() => {},
		);
		return task;
	};
}
