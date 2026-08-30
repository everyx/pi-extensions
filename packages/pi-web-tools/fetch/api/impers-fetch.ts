/**
 * pi-web-tools — impers channel: FULL browser impersonation for the direct
 * fetch tier (TLS JA3/JA4 + HTTP/2 SETTINGS/伪头序 + 头部值与序), replacing
 * the hand-rolled header mimicry.
 *
 * Why not hand-write headers anymore: impers' profiles are captured from
 * real browsers — values right, ORDER right, and the TLS layer right (the
 * wall undici could never cross). Manual header simulation was a poor-man's
 * impersonation that died at TLS; the real thing is one option flag.
 *
 * Lazy: the native lib (libcurl-impersonate v2.0.0) downloads on first use;
 * an unloadable/missing lib yields null and the caller falls back to the
 * degraded plain-fetch tier. PI_WEB_TOOLS_NO_IMPERS=1 forces the degraded
 * tier (hermetic tests, offline environments).
 *
 * Only two header overrides survive (deliberate policy, not mimicry):
 *   - Accept: agent-friendly content negotiation (text/markdown) — kept as a
 *     feature; raw requests get the HTML Accept.
 *   - Cache-Control: no-cache — freshness over fingerprint fidelity.
 *
 * Body handling: stream mode + self-decoding. impers only auto-decodes
 * content-encoding in non-stream mode, which buffers the entire body in
 * memory; we need the bounded download cap, so chunks flow through a
 * streaming decoder (br/gzip/deflate) wired from headerCallback.
 */

import type { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Flush a streaming decoder to completion (no-op when null). */
async function drainDecoder(decoder: Transform | null): Promise<void> {
	if (!decoder) return;
	decoder.end();
	await finished(decoder).catch(() => {});
}

/** Streaming decoder for a content-encoding token; identity/unknown → null
 *  (pass through raw). Multi-token encodings: decode the outermost (last). */
function channelFor(contentEncoding: string): Transform | null {
	switch (contentEncoding) {
		case "gzip":
		case "x-gzip":
			return createGunzip();
		case "br":
			return createBrotliDecompress();
		case "deflate":
			return createInflate();
		default:
			return null;
	}
}

/** Transport result with the pieces fetchPage needs to finish the page. */
export interface ImpersRawResult {
	ok: boolean;
	status: number;
	contentType?: string;
	/** Full body bytes (streamed in, capped at maxBytes by the caller). */
	bytes?: Uint8Array;
	tooLarge?: boolean;
	error?: string;
}

/** Pure option builder (unit-tested without the native lib). */
export function buildImpersOptions(accept: string, timeoutMs: number, maxRedirects = 10): Record<string, unknown> {
	return {
		impersonate: "chrome",
		headers: { Accept: accept, "Cache-Control": "no-cache" },
		// impers timeouts are in SECONDS; round up so a 30s budget never
		// truncates to 29 (resolution loss, not policy).
		timeout: Math.max(1, Math.round(timeoutMs / 1000)),
		maxRedirects,
		stream: true,
	};
}

/** Environment escape hatch: forced degraded tier. */
export function impersForcedOff(): boolean {
	return process.env.PI_WEB_TOOLS_NO_IMPERS === "1";
}

/** Lazy-load impers once; null when disabled or the binary is unavailable. */
let loadPromise: Promise<typeof import("impers") | null> | undefined;
export function loadImpers(): Promise<typeof import("impers") | null> {
	if (impersForcedOff()) return Promise.resolve(null);
	loadPromise ??= import("impers").catch(() => null);
	return loadPromise;
}

/**
 * Direct fetch with full browser impersonation. Returns null when the
 * channel is unavailable (disabled env / missing lib / request error —
 * callers treat null like the fuse advancing). Abort signals propagate
 * (caller must not swallow them).
 */
export async function impersFetchRaw(
	url: string,
	opts: { signal?: AbortSignal; timeoutMs: number; accept: string; maxBytes: number },
): Promise<ImpersRawResult | null> {
	const impers = await loadImpers();
	if (!impers) return null;
	let chunks: Uint8Array[] = [];
	let total = 0;
	let tooLarge = false;

	// Streaming decoder, wired from headerCallback before the body flows.
	let inflater: Transform | null = null;
	let decodeFailed = false;
	const collect = (chunk: Uint8Array): void => {
		if (tooLarge) return;
		total += chunk.length;
		if (total > opts.maxBytes) {
			tooLarge = true;
			chunks = [];
			return;
		}
		chunks.push(chunk);
	};

	let response: {
		statusCode?: number;
		contentType?: string | null;
	};
	try {
		response = await impers.get(url, {
			...buildImpersOptions(opts.accept, opts.timeoutMs),
			signal: opts.signal,
			headerCallback: (buf: Buffer) => {
				const m = /content-encoding:\s*([^\r\n]+)/i.exec(buf.toString("latin1"));
				if (m) {
					const enc =
						m[1]
							.trim()
							.toLowerCase()
							.split(/\s*,\s*/)
							.pop() ?? "";
					inflater = channelFor(enc);
					if (inflater) {
						inflater.on("data", collect);
						inflater.on("error", () => {
							decodeFailed = true;
						});
					}
				}
			},
			contentCallback: (chunk: Buffer) => {
				if (inflater) inflater.write(chunk);
				else collect(new Uint8Array(chunk));
			},
		});
	} catch (err) {
		// Preserve abort semantics — the caller must see cancellation, not a
		// fuse advance. Everything else is a channel failure (→ degraded tier).
		if (err instanceof Error && err.name === "AbortError") throw err;
		return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
	}

	// Drain the decoder through a function parameter: TS narrows closure-
	// written variables to `never` at use sites, a function boundary keeps
	// the static type.
	await drainDecoder(inflater);

	const contentType = response.contentType ?? "";
	const status = response.statusCode ?? 0;
	if (status >= 400) {
		return { ok: false, status, contentType, error: `HTTP ${status}` };
	}
	if (decodeFailed) return { ok: false, status, contentType, error: "response decode failed" };
	if (tooLarge) return { ok: true, status, contentType, tooLarge: true };

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.length;
	}
	return { ok: true, status, contentType, bytes };
}
