/**
 * pi-web-tools — shared HTTP helpers (timeout + abort wiring).
 */

interface HttpOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** Keep cancellation and the deadline active until the response consumer settles. */
export async function fetchWithTimeout<T>(
	url: string,
	init: RequestInit,
	options: HttpOptions,
	consume: (response: Response) => Promise<T>,
): Promise<T> {
	options.signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;

	const onAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	let response: Response | undefined;
	try {
		response = await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { ...options.headers, ...init.headers },
		});
		return await consume(response);
	} catch (err) {
		// Distinguish our timeout abort from a caller/external cancel (which
		// surfaces as the raw AbortError) so callers can report it honestly.
		if (timedOut) throw new Error(`Timed out after ${timeoutMs}ms`);
		throw err;
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", onAbort);
		controller.abort();
		await response?.body?.cancel().catch(() => {});
	}
}
