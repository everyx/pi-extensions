/**
 * pi-web-tools — the direct-fetch transport.
 *
 * One path: Node's fetch (undici) in-process, with a proxy-aware dispatcher.
 * It used to shell out to the system `curl` and keep this as a fallback, on the
 * theory that a real curl identity buys access. A side-by-side run over the same
 * headers said otherwise — the blocked sites answered 403 to both, the open ones
 * 200 to both — so the second transport only cost us a subprocess, a temp
 * directory for response headers, argv handling, and two implementations to keep
 * in step.
 *
 * What curl did give us for free and is therefore restored here explicitly:
 *   - proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`);
 *     Node's fetch ignores them, so the dispatcher is `EnvHttpProxyAgent`.
 *
 * The body is read as a stream against a hard cap: past it the stream is
 * abandoned (not buffered "just in case") and the caller learns the response
 * was too large rather than silently receiving a truncated page.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

export interface DirectFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Body cap; past it the stream is cancelled and nothing more is read. */
	maxBytes?: number;
}

export interface DirectFetchResult {
	ok: boolean;
	status: number;
	contentType: string;
	bytes: Uint8Array | null;
	tooLarge: boolean;
	error?: string;
}

/** One proxy-aware agent for the process: undici clients are pools, so building
 *  a fresh agent per request would leak connections. */
let dispatcher: EnvHttpProxyAgent | undefined;
function getDispatcher(): EnvHttpProxyAgent {
	dispatcher ??= new EnvHttpProxyAgent();
	return dispatcher;
}

/** Transport-level failure in words a model can act on. */
function describeNetworkError(err: unknown): string {
	const cause = (err as { cause?: { code?: string; message?: string } }).cause;
	const code = cause?.code;
	const byCode: Record<string, string> = {
		ECONNRESET: "connection reset",
		ECONNREFUSED: "connection refused",
		ENOTFOUND: "domain not found",
		EAI_AGAIN: "DNS temporarily unavailable",
		ETIMEDOUT: "connection timed out",
		EPIPE: "connection closed early",
		EHOSTUNREACH: "host unreachable",
		CERT_HAS_EXPIRED: "TLS certificate expired",
		UND_ERR_CONNECT_TIMEOUT: "connect timed out",
		UND_ERR_HEADERS_TIMEOUT: "server did not send headers in time",
		UND_ERR_BODY_TIMEOUT: "server stalled mid-body",
		UND_ERR_SOCKET: "socket closed",
	};
	if (code && byCode[code]) return byCode[code];
	if (err instanceof Error) return err.message;
	return "request failed";
}

/** True when the failure is worth another attempt (transient by nature). */
export function isTransientError(message: string): boolean {
	return /connection reset|DNS temporarily unavailable|connect timed out|connection closed early|socket closed|server did not send headers|server stalled/i.test(
		message,
	);
}

/** Read the body under a byte cap; `tooLarge` instead of a truncated array. */
async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array | null; tooLarge: boolean }> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) return { bytes: null, tooLarge: true };
	if (!response.body) return { bytes: new Uint8Array(0), tooLarge: false };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				return { bytes: null, tooLarge: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}

	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes: out, tooLarge: false };
}

/** GET one URL. Never throws: every outcome is a normalized result. */
export async function directFetch(url: string, options: DirectFetchOptions = {}): Promise<DirectFetchResult> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;

	// Compose the caller's cancellation with our own deadline: either one ends
	// the request, and neither should mask the other.
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);

	try {
		const response = await undiciFetch(url, {
			signal,
			redirect: "follow",
			dispatcher: getDispatcher(),
		});
		const contentType = response.headers.get("content-type") ?? "";
		const { bytes, tooLarge } = await readBodyCapped(response, maxBytes);
		if (tooLarge) return { ok: true, status: response.status, contentType, bytes: null, tooLarge: true };
		if (!response.ok) {
			const reason = response.statusText ? `: ${response.statusText}` : "";
			return {
				ok: false,
				status: response.status,
				contentType,
				bytes: null,
				tooLarge: false,
				error: `HTTP ${response.status}${reason}`,
			};
		}
		return { ok: true, status: response.status, contentType, bytes, tooLarge: false };
	} catch (err) {
		if (options.signal?.aborted) {
			return { ok: false, status: 0, contentType: "", bytes: null, tooLarge: false, error: "fetch aborted" };
		}
		if (err instanceof Error && err.name === "TimeoutError") {
			return {
				ok: false,
				status: 0,
				contentType: "",
				bytes: null,
				tooLarge: false,
				error: "request timed out",
			};
		}
		return {
			ok: false,
			status: 0,
			contentType: "",
			bytes: null,
			tooLarge: false,
			error: describeNetworkError(err),
		};
	}
}
