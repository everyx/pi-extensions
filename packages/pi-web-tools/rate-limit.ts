/**
 * pi-web-tools — per-provider concurrency control.
 *
 * Two primitives:
 *   - createRateLimiter(qps) — serializes calls with a 1000/qps minimum
 *     interval (no qps = pass-through, no unnecessary serialization).
 *     `runBefore()` additionally lets a *queued* call give up when its
 *     deadline passes or the caller cancels.
 *   - createSerialQueue(open, close) — runs queued tasks strictly one at a
 *     time, reusing a shared context (e.g. one browser session for a batch of
 *     searches), opening it lazily and closing it when the queue drains.
 *
 * Researched rate limits — each channel declares its own qps (search/api/):
 *   - Exa MCP (keyless): 3 qps (keyless 150 calls/day)
 *   - TinyFish:          0.4 qps (free tier 30 req/min)
 *   - Firecrawl:         1 qps
 *   - Tavily free tier:  1 qps (account-level)
 *   - Exa REST (key):    credit-metered, qps not published — left unlimited
 */

/** What a queued call may give up on. `deadline` is an absolute epoch ms. */
export interface RunBudget {
	deadline: number;
	signal?: AbortSignal;
}

interface RateLimiter {
	/** Run fn under this limiter's throttle (pass-through when unlimited). */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/**
	 * Run fn, but let the *wait* expire too: a call still queued when the
	 * deadline passes or the caller cancels resolves `null` without ever
	 * running fn. Without that, "the fuse has 45 s" would only bound the HTTP
	 * requests while a queue slot could hold the caller for minutes.
	 *
	 * The bound is on how long the caller waits, NOT on the work: once fn has
	 * started, a late deadline resolves the caller's promise with `null` and
	 * lets fn finish in the background (its result is discarded). Callers that
	 * need the work stopped must give fn its own deadline or signal — ours do,
	 * by handing `remaining` to fetchWithTimeout.
	 */
	runBefore<T>(fn: () => Promise<T>, budget: RunBudget): Promise<T | null>;
}

const expired = (budget: RunBudget): boolean => budget.signal?.aborted === true || Date.now() >= budget.deadline;

export function createRateLimiter(qps?: number): RateLimiter {
	const minIntervalMs = qps && qps > 0 ? 1000 / qps : 0;
	if (!minIntervalMs) {
		// Unlimited: pass through untouched, but still respect the budget.
		return {
			run: (fn) => fn(),
			runBefore: <T>(fn: () => Promise<T>, budget: RunBudget) => (expired(budget) ? Promise.resolve(null) : fn()),
		};
	}

	let chain: Promise<void> = Promise.resolve();

	/** Original semantics: the promise settles when fn does, errors included. */
	function enqueue<T>(fn: () => Promise<T>): Promise<T> {
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
	}

	/** Budgeted variant: a queued call may leave the queue before its turn. */
	function enqueueBefore<T>(fn: () => Promise<T>, budget: RunBudget): Promise<T | null> {
		if (expired(budget)) return Promise.resolve(null);

		let settle: (value: T | null) => void = () => {};
		let fail: (err: unknown) => void = () => {};
		const settled = new Promise<T | null>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});

		// Two independent ways to leave the queue early: the caller cancels, or the
		// call's own deadline expires. The second needs its own timer — checking
		// `expired()` when the task reaches the front only proves it will not run,
		// not that the caller stops waiting for everyone ahead of it.
		//
		// Both settle the caller. Neither cancels work that already started: a
		// late `settle` is a no-op on a settled promise, and the running call is
		// left to its own timeout (see the interface doc above).
		let abandoned = false;
		const leave = () => {
			abandoned = true;
			settle(null);
		};
		const timer = setTimeout(leave, Math.max(0, budget.deadline - Date.now()));
		budget.signal?.addEventListener("abort", leave, { once: true });

		const queued = chain.then(async () => {
			// The caller gave up (or the fuse ran out) while this call sat in the
			// queue — do not start a request just to have it skipped afterwards.
			if (abandoned || expired(budget)) {
				settle(null);
				return;
			}
			try {
				settle(await fn());
			} catch (err) {
				fail(err);
			} finally {
				await sleep(minIntervalMs);
			}
		});
		chain = queued.then(
			() => undefined,
			() => undefined,
		);

		return settled.finally(() => {
			clearTimeout(timer);
			budget.signal?.removeEventListener("abort", leave);
		});
	}

	return {
		run: enqueue,
		runBefore: enqueueBefore,
	};
}

/**
 * Serial task queue sharing one lazily-opened context.
 *
 * Tasks run one at a time; the context (e.g. a browser session id) is opened on
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
			// Tasks enqueued while we were draining (e.g. during the async
			// close) were swallowed by the `if (processing) return` guard —
			// pick them up now, or they would wait forever.
			if (queue.length > 0) void drain();
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
