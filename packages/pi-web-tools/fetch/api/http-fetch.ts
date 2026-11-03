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

import { readFileSync } from "node:fs";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/** Who we are, in the one place a site operator can look it up.
 *
 *  The `Mozilla/5.0 (compatible; …)` form is the convention for a client that
 *  wants browser-shaped handling without claiming to be a browser — gemini-cli,
 *  opencode and cline all use it, and dsh spells the intent out ("an explicit
 *  product agent, never a browser disguise"). It buys nothing measurable
 *  against an anti-bot wall; it is here so a site that reads its logs can tell
 *  what hit it and where to complain. */
function packageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		return typeof pkg.version === "string" && pkg.version.trim() ? `/${pkg.version.trim()}` : "";
	} catch {
		return "";
	}
}

let userAgent: string | undefined;
export function defaultUserAgent(): string {
	userAgent ??= `Mozilla/5.0 (compatible; pi-web-tools${packageVersion()}; +https://github.com/everyx/pi-extensions)`;
	return userAgent;
}

/** Format the caller asks for; it decides the `Accept` order. */
export type AcceptFormat = "markdown" | "html";

/**
 * The `Accept` header.
 *
 * Asking for markdown first is the one header change that pays for itself:
 * Cloudflare's Markdown for Agents converts at the edge when the client asks
 * (measured 16 KB of markdown against 176 KB of HTML for the same page), and
 * any static doc server can serve it. It does not change whether an anti-bot
 * gate opens — that was measured too, on zones without the feature, which
 * still answered a challenge — so it is a token win, not an access win.
 */
function acceptHeader(format: AcceptFormat): string {
	return format === "markdown"
		? "text/markdown, text/html;q=0.9, */*;q=0.5"
		: "text/html, application/xhtml+xml;q=0.9, */*;q=0.5";
}

export interface DirectFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Body cap; past it the stream is cancelled and nothing more is read. */
	maxBytes?: number;
	/** What the caller wants back — decides `Accept`. Defaults to markdown. */
	format?: AcceptFormat;
}

export interface DirectFetchResult {
	ok: boolean;
	status: number;
	contentType: string;
	bytes: Uint8Array | null;
	tooLarge: boolean;
	error?: string;
	/** Set when the response is a JavaScript challenge (Cloudflare, AWS WAF,
	 *  an interstitial). The page exists; only a real browser gets past it, so
	 *  this tells the fuse *why* it is being invoked and tells the model the
	 *  difference between "blocked" and "missing". */
	challenge?: string;
	/** How many requests were spent (1 unless a transient failure was retried). */
	attempts?: number;
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

/** Statuses worth another attempt: rate limiting and transient upstream errors.
 *  4xx other than 429 is the server saying "no", which a retry cannot change. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** Total attempts, including the first. Three is enough to ride out a blip
 *  without spending the fuse budget on something that is not coming back. */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

/** Signs that a short body is a wall rather than content.
 *
 *  The last patterns matter as much as the first: some sites answer **200** with
 *  a "you have been blocked" page, which looks like a success to every layer
 *  above and hands the model a polite refusal dressed as content. */
const CHALLENGE_MARKERS: Array<[RegExp, string]> = [
	[/just a moment|enable javascript and cookies|checking your browser|cf_chl_/i, "Cloudflare"],
	[/captcha|are you a robot|automated requests/i, "bot check"],
	[/blocked by network security|you have been blocked|access denied|request blocked|unusual traffic/i, "network block"],
];

/** Header signals, checked before the body: they are unambiguous. */
function challengeFromHeaders(status: number, headers: Headers): string | undefined {
	if (status !== 403 && status !== 202 && status !== 503) return undefined;
	if (headers.get("cf-mitigated") === "challenge") return "Cloudflare";
	const waf = headers.get("x-amzn-waf-action");
	if (waf === "challenge" || waf === "captcha") return "AWS WAF";
	return undefined;
}

/** A challenge page answers 200 sometimes; the body is the only tell left. */
function challengeFromBody(text: string): string | undefined {
	for (const [pattern, name] of CHALLENGE_MARKERS) if (pattern.test(text)) return name;
	return undefined;
}

/**
 * Is this text a wall rather than content?
 *
 * Exported because a *renderer* is subject to the same lie: Firecrawl happily
 * returns "Blocked by network security" as clean markdown with a 200, and the
 * fuse had no reason to doubt it. Checking the text where it arrives — whoever
 * produced it — is what keeps a polite refusal from being reported as a page.
 */
export function describeWall(text: string): string | undefined {
	return challengeFromBody(text);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One attempt. Separated so the retry loop stays readable. */
async function attemptOnce(url: string, options: DirectFetchOptions, timeoutMs: number): Promise<DirectFetchResult> {
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);

	try {
		const response = await undiciFetch(url, {
			signal,
			redirect: "follow",
			dispatcher: getDispatcher(),
			headers: {
				"User-Agent": defaultUserAgent(),
				Accept: acceptHeader(options.format ?? "markdown"),
				// curl sent none of this by default. A locale header is content
				// negotiation, not impersonation, and it is what flipped a 403 to
				// 200 in the one measured header-level win.
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
		const contentType = response.headers.get("content-type") ?? "";

		// Classify a wall before reading the body: a challenge is not a failure
		// to retry, and the model deserves to know it was blocked rather than
		// told the page is broken.
		const headerChallenge = challengeFromHeaders(response.status, response.headers);
		if (headerChallenge) {
			await response.body?.cancel().catch(() => {});
			return {
				ok: false,
				status: response.status,
				contentType,
				bytes: null,
				tooLarge: false,
				challenge: headerChallenge,
				error: `blocked by a ${headerChallenge} challenge`,
			};
		}

		const { bytes, tooLarge } = await readBodyCapped(response, maxBytesOf(options));
		if (tooLarge) return { ok: true, status: response.status, contentType, bytes: null, tooLarge: true };

		// Challenge pages answer 403, 503, and sometimes 200; the text is the only
		// tell left. Only small bodies qualify — a real article is not one, and a
		// long page that merely mentions captchas must not be mistaken for a wall.
		const looksLikeWall = !response.ok || (bytes?.length ?? 0) <= 4 * 1024;
		const bodyChallenge = looksLikeWall && bytes ? challengeFromBody(new TextDecoder().decode(bytes)) : undefined;
		if (bodyChallenge) {
			return {
				ok: false,
				status: response.status,
				contentType,
				bytes: null,
				tooLarge: false,
				challenge: bodyChallenge,
				error: `blocked by a ${bodyChallenge} challenge`,
			};
		}

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
			return { ok: false, status: 0, contentType: "", bytes: null, tooLarge: false, error: "request timed out" };
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

const maxBytesOf = (options: DirectFetchOptions) => options.maxBytes ?? 64 * 1024 * 1024;

/**
 * GET one URL, retrying only what a retry can fix.
 *
 * Two failure classes, deliberately treated differently:
 *   - a JavaScript challenge (Cloudflare/WAF) is stable across attempts and
 *     across client configs — retrying it burns the caller's time and our IP
 *     reputation for a result that does not change;
 *   - a rate limit or a transient upstream error (429/502/503/504, connection
 *     reset, DNS hiccup) often clears on its own, and one extra attempt is
 *     cheaper than falling back to a third-party renderer.
 *
 * Never throws: every outcome is a normalized result.
 */
export async function directFetch(url: string, options: DirectFetchOptions = {}): Promise<DirectFetchResult> {
	const totalBudgetMs = options.timeoutMs ?? 15_000;
	const deadline = Date.now() + totalBudgetMs;

	let result = await attemptOnce(url, options, totalBudgetMs);
	let attempts = 1;
	while (attempts < MAX_ATTEMPTS && shouldRetry(result, options)) {
		const remaining = deadline - Date.now();
		if (remaining <= BASE_DELAY_MS) break;
		// Exponential backoff with jitter: a burst of clients must not resynchronise.
		const wait = Math.min(BASE_DELAY_MS * 3 ** (attempts - 1) * (0.8 + Math.random() * 0.4), remaining - 1);
		await sleep(wait);
		result = await attemptOnce(url, options, deadline - Date.now());
		attempts++;
	}
	return { ...result, attempts };
}

/** Whether another attempt could plausibly answer differently. */
function shouldRetry(result: DirectFetchResult, options: DirectFetchOptions): boolean {
	if (options.signal?.aborted) return false;
	if (result.challenge) return false;
	if (result.tooLarge) return false;
	if (result.status === 0) return isTransientError(result.error ?? "");
	return RETRY_STATUSES.has(result.status);
}
