/**
 * pi-web-tools — shared HTTP helpers (timeout + abort wiring).
 */

interface HttpOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/**
 * fetch with a deadline and the caller's cancellation, kept alive for the
 * whole response — including the body.
 *
 * The lifetime belongs to the request, not to this function. An earlier
 * version ran a controller + `setTimeout` and tore them down in `finally`,
 * which fires as soon as the response *headers* arrive; everything after that
 * (`response.text()`, `reader.read()`) was outside both the deadline and the
 * cancel, so an abandoned fetch could keep streaming and still report success.
 *
 * Composing signals instead of supervising a timer keeps them attached to the
 * response: fetch binds the signal to the body stream, `AbortSignal.timeout`
 * timers are unref'd (nothing to clear, and a pending deadline never holds the
 * process open), and there is no listener to remove. Which signal fired also
 * answers "was this a timeout?" without a mutable flag.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

	try {
		return await fetch(url, {
			...init,
			signal,
			headers: { ...options.headers, ...init.headers },
		});
	} catch (err) {
		// Distinguish our timeout from a caller/external cancel so callers can
		// report it honestly.
		if (deadline.aborted) throw new Error(`Timed out after ${timeoutMs}ms`);
		throw err;
	}
}
