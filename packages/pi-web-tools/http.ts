/**
 * pi-web-tools — shared HTTP helpers (timeout + abort wiring).
 */

interface HttpOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** fetch with a hard timeout that races the caller's AbortSignal. */
export async function fetchWithTimeout(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;

	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { ...options.headers, ...init.headers },
		});
	} catch (err) {
		// Distinguish our timeout abort from a caller/external cancel (which
		// surfaces as the raw AbortError) so callers can report it honestly.
		if (timedOut) throw new Error(`Timed out after ${timeoutMs}ms`);
		throw err;
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
