/**
 * pi-web-tools — shared HTTP helpers (timeout + abort wiring).
 */

export interface HttpOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** fetch with a hard timeout that races the caller's AbortSignal. */
export async function fetchWithTimeout(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	const controller = new AbortController();

	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { ...options.headers, ...init.headers },
		});
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/** Normalize an unknown thrown value into a message. */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
