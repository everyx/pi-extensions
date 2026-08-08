/**
 * pi-web-tools — per-provider concurrency control.
 *
 * Two primitives:
 *   - createRateLimiter(qps) — serializes calls with a 1000/qps minimum
 *     interval (no qps = pass-through, no unnecessary serialization).
 *   - createSerialQueue(open, close) — runs queued tasks strictly one at a
 *     time, reusing a shared context (e.g. one bsk session for a batch of
 *     searches), opening it lazily and closing it when the queue drains.
 *
 * Researched rate limits (providers declare their own qps):
 *   - Exa MCP (keyless): 3 qps (150 calls/day)
 *   - Tavily free tier:  1 qps, account-level
 *   - Parallel:          600 RPM (10 qps)
 *   - Exa REST (key):    credit-metered, qps not published — left unlimited
 */

export interface RateLimiter {
	/** Run fn under this limiter's throttle (pass-through when unlimited). */
	run<T>(fn: () => Promise<T>): Promise<T>;
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

/**
 * Serial task queue sharing one lazily-opened context.
 *
 * Tasks run one at a time; the context (e.g. a bsk session id) is opened on
 * first use and closed when the queue drains — so a burst of queued searches
 * shares a single browser session (SPEC: 批量搜索一次打开浏览器).
 */
export interface SerialQueue<TContext> {
	run<T>(fn: (ctx: TContext) => Promise<T>): Promise<T>;
}

export function createSerialQueue<TContext>(
	open: () => Promise<TContext>,
	close: (ctx: TContext) => Promise<void>,
): SerialQueue<TContext> {
	interface Task {
		fn: (ctx: TContext) => Promise<unknown>;
		resolve: (value: unknown) => void;
		reject: (err: unknown) => void;
	}

	let queue: Task[] = [];
	let processing = false;
	let ctx: TContext | null = null;

	return {
		run<T>(fn: (ctx: TContext) => Promise<T>): Promise<T> {
			return new Promise((resolve, reject) => {
				queue.push({
					fn: async (c) => {
						const result = await fn(c);
						resolve(result);
					},
					resolve: resolve as (value: unknown) => void,
					reject,
				});
				void drain();
			});
		},
	};

	async function drain(): Promise<void> {
		if (processing) return;
		processing = true;
		try {
			while (queue.length > 0) {
				if (!ctx) {
					try {
						ctx = await open();
					} catch (err) {
						// Open failed: reject every queued task; the next run()
						// starts a fresh attempt.
						const failed = queue;
						queue = [];
						for (const task of failed) task.reject(err);
						return;
					}
				}
				const batch = queue;
				queue = [];
				for (const task of batch) {
					try {
						await task.fn(ctx);
					} catch (err) {
						task.reject(err);
					}
				}
			}
		} finally {
			if (ctx) {
				await close(ctx).catch(() => {});
				ctx = null;
			}
			processing = false;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
