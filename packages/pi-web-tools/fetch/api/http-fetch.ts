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
	/** Dispatch attempts: retries and the http fallback count, redirect hops do
	 *  not (those are one logical fetch). */
	attempts?: number;
	/** Where the chain ended, when it went anywhere (equal to the request otherwise). */
	finalUrl?: string;
	/** Every hop taken, in order. */
	redirects?: RedirectHop[];
}

/** One redirect the chain followed. */
export interface RedirectHop {
	from: string;
	to: string;
	status: number;
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

/** Read at most `maxBytes` from the body, whatever the headers claim.
 *
 *  Used for sniffing a wall notice on an error response: there the declared
 *  length is irrelevant — a challenge page can announce 1 MB and still say
 *  "Just a moment" in its first line, and skipping the read would lose the
 *  classification (and with it the reason the caller is told).
 */
async function readPrefix(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.length;
		}
	} catch {
		// A connection that dies mid-sniff still leaves us the bytes we got.
	}
	await reader.cancel().catch(() => {});
	reader.releaseLock?.();

	const out = new Uint8Array(Math.min(size, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		const room = out.length - offset;
		if (room <= 0) break;
		out.set(chunk.subarray(0, room), offset);
		offset += Math.min(chunk.length, room);
	}
	return out;
}

/** Read the body under a byte cap; `tooLarge` instead of a truncated array. */
async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array | null; tooLarge: boolean }> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		// Nothing will be read, so release the stream rather than leaving it
		// dangling on a connection that could otherwise be reused.
		await response.body?.cancel().catch(() => {});
		return { bytes: null, tooLarge: true };
	}
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

/** Statuses that carry a `Location` we are expected to act on. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** A chain longer than this is a loop, not a chain. */
const MAX_REDIRECTS = 10;

/** Hosts that are not on the public internet. Following a *page's* redirect
 *  into one of these is the classic injected-navigation move, so it is refused
 *  before the request goes out. This is a name check, not a resolver check —
 *  a hostname that resolves to 10.x still gets through (see SPEC). */
const PRIVATE_LITERAL =
	/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe[89ab][0-9a-f]:)/i;
const PRIVATE_NAME = /^(localhost|\.local|.*\.internal|.*\.localdomain)$/i;

function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	// `::ffff:127.0.0.1` is 127.0.0.1 wearing an IPv6 coat; judge the IPv4 part.
	// WHATWG URL normalises it to hex (`[::ffff:7f00:1]`), so both forms are read.
	const dotted = /^\[?::ffff:(\d+\.\d+\.\d+\.\d+)\]?$/.exec(host);
	if (dotted) return isPrivateHost(dotted[1]);
	const hex = /^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/.exec(host);
	if (hex) {
		const hi = Number.parseInt(hex[1], 16);
		const lo = Number.parseInt(hex[2], 16);
		return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	return PRIVATE_LITERAL.test(host) || PRIVATE_NAME.test(host) || host === "::1" || host === "[::1]";
}

/**
 * Should this hop be refused before it is made?
 *
 * The risk is one-directional: a page the caller fetched on the public internet
 * pointing at a private address. A caller already talking to a private host is
 * inside that trust domain, and blocking its own redirects would break every
 * local development server for no security gain.
 *
 * Returns the refusal reason, or undefined to proceed.
 */
export function redirectRefusal(startedPrivate: boolean, next: URL): string | undefined {
	if (startedPrivate) return undefined;
	if (!isPrivateHost(next.hostname)) return undefined;
	return `redirect into a private address refused: ${next.host}`;
}

/** Claude Code's rule, and a good one: a bare hostname means the local machine
 *  or an intranet, which is what `bash curl` is for. */
function hasNoDot(hostname: string): boolean {
	return !hostname.includes(".") && !hostname.includes(":");
}

/** One attempt, including the redirect chain it walks. */
async function attemptOnce(url: string, options: DirectFetchOptions, timeoutMs: number): Promise<DirectFetchResult> {
	const deadline = Date.now() + timeoutMs;
	const redirects: RedirectHop[] = [];
	let current = url;

	// Reject the shapes that mean "this machine", before any request is made.
	const entry = new URL(url);
	// The guard below is about a *public* page navigating the caller somewhere
	// private. A caller already talking to a private host (a local dev server)
	// is inside that trust domain, and following its redirects is the whole
	// point of talking to it.
	const startedPrivate = isPrivateHost(entry.hostname);
	if (hasNoDot(entry.hostname)) {
		return {
			ok: false,
			status: 0,
			contentType: "",
			bytes: null,
			tooLarge: false,
			error: "hostnames without a dot are not supported (use bash curl for a local server)",
		};
	}

	for (let hops = 0; ; hops++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return {
				ok: false,
				status: 0,
				contentType: "",
				bytes: null,
				tooLarge: false,
				error: "request timed out",
				finalUrl: current,
				redirects,
			};
		}
		const signal = options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)])
			: AbortSignal.timeout(remaining);

		let response: Response;
		try {
			response = await undiciFetch(current, {
				signal,
				// Walked by hand: the chain is what tells the caller it landed
				// somewhere other than the URL it asked for.
				redirect: "manual",
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
		} catch (err) {
			return { ...networkFailure(err, options), finalUrl: current, redirects };
		}

		const location = response.headers.get("location");
		if (REDIRECT_STATUSES.has(response.status) && location) {
			await response.body?.cancel().catch(() => {});
			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				return {
					ok: false,
					status: response.status,
					contentType: "",
					bytes: null,
					tooLarge: false,
					error: `redirect to an unusable location: ${location}`,
					finalUrl: current,
					redirects,
				};
			}
			if (next.protocol !== "http:" && next.protocol !== "https:") {
				return {
					ok: false,
					status: response.status,
					contentType: "",
					bytes: null,
					tooLarge: false,
					error: `redirect to a non-http location: ${next.protocol}`,
					finalUrl: current,
					redirects,
				};
			}
			// A page navigating the caller into a private network is the case this
			// guard exists for. The model asking for one directly is a different
			// matter — that is visible in the transcript, this is not.
			const refusal = redirectRefusal(startedPrivate, next);
			if (refusal) {
				return {
					ok: false,
					status: response.status,
					contentType: "",
					bytes: null,
					tooLarge: false,
					error: refusal,
					finalUrl: current,
					redirects,
				};
			}
			if (hops + 1 > MAX_REDIRECTS) {
				return {
					ok: false,
					status: response.status,
					contentType: "",
					bytes: null,
					tooLarge: false,
					error: `too many redirects (more than ${MAX_REDIRECTS})`,
					finalUrl: current,
					redirects,
				};
			}
			redirects.push({ from: current, to: next.href, status: response.status });
			current = next.href;
			continue;
		}

		// Reading the body is part of the request: a reset mid-stream, a body
		// timeout, or the caller cancelling all surface here. Letting them escape
		// would break the "never throws" contract and, worse, skip the rendering
		// fuse that exists for exactly this kind of failure.
		try {
			return { ...(await finishResponse(response, options, current, redirects)), finalUrl: current, redirects };
		} catch (err) {
			return { ...networkFailure(err, options), finalUrl: current, redirects };
		}
	}
}

/** Turn the final response into a normalized result. */
async function finishResponse(
	response: Response,
	options: DirectFetchOptions,
	current: string,
	redirects: RedirectHop[],
): Promise<DirectFetchResult> {
	const contentType = response.headers.get("content-type") ?? "";

	// Classify a wall before reading the body: a challenge is not a failure to
	// retry, and the model deserves to know it was blocked rather than told the
	// page is broken.
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
			finalUrl: current,
			redirects,
		};
	}

	// Status first, size second. A 404 whose error page happens to be enormous is
	// still a 404 — deciding "too large, therefore fine" before looking at the
	// status would report a missing page as a successful oversized one.
	if (!response.ok) {
		// Sniff a prefix for the wall check; a big error page is not content, but
		// its first line may still say "Just a moment".
		const prefix = await readPrefix(response, Math.min(maxBytesOf(options), 64 * 1024));
		const bodyChallenge = prefix.length ? challengeFromBody(new TextDecoder().decode(prefix)) : undefined;
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

	const { bytes, tooLarge } = await readBodyCapped(response, maxBytesOf(options));
	if (tooLarge) return { ok: true, status: response.status, contentType, bytes: null, tooLarge: true };

	// A 2xx can still be a wall: challenge pages answer 200 with a short body,
	// and the text is the only tell left. Only small bodies qualify — a real
	// article is not one, and a long page mentioning captchas is not a wall.
	if (bytes && bytes.length <= 4 * 1024) {
		const bodyChallenge = challengeFromBody(new TextDecoder().decode(bytes));
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
	}
	return { ok: true, status: response.status, contentType, bytes, tooLarge: false };
}

/** Transport failure in words the caller can act on. */
function networkFailure(err: unknown, options: DirectFetchOptions): DirectFetchResult {
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

	// Parse once, here: `attemptOnce` builds a URL on entry, and a malformed one
	// (`http://[`) would otherwise escape as a throw — the one thing this
	// function promises never to do.
	try {
		new URL(url);
	} catch {
		return { ok: false, status: 0, contentType: "", bytes: null, tooLarge: false, error: `invalid URL: ${url}` };
	}

	// Prefer TLS when the caller wrote http:// and the host is on the public
	// internet: a plaintext fetch is a downgrade we can simply avoid. If the
	// host genuinely does not speak TLS, the original URL is tried once — the
	// caller did ask for http, and plenty of small sites still only answer it.
	const upgraded = upgradeToHttps(url);
	let target = upgraded ?? url;
	let attempts = 0;
	const dispatch = (to: string) => {
		attempts++;
		return attemptOnce(to, options, deadline - Date.now());
	};

	let result = await dispatch(target);
	if (upgraded && !result.ok && result.status === 0 && !options.signal?.aborted) {
		// Transport-level failure only: an HTTP answer means the host speaks TLS
		// and its status is the answer.
		target = url;
		result = await dispatch(url);
	}

	while (attempts < MAX_ATTEMPTS && shouldRetry(result, options)) {
		const remaining = deadline - Date.now();
		if (remaining <= BASE_DELAY_MS) break;
		// Exponential backoff with jitter: a burst of clients must not resynchronise.
		const wait = Math.min(BASE_DELAY_MS * 3 ** (attempts - 1) * (0.8 + Math.random() * 0.4), remaining - 1);
		await sleep(wait);
		result = await dispatch(target);
	}
	return { ...result, attempts };
}

/** http:// → https:// for public hosts; undefined when there is nothing to do. */
export function upgradeToHttps(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:") return undefined;
	if (hasNoDot(parsed.hostname) || isPrivateHost(parsed.hostname)) return undefined;
	parsed.protocol = "https:";
	return parsed.href;
}

/** Whether another attempt could plausibly answer differently. */
function shouldRetry(result: DirectFetchResult, options: DirectFetchOptions): boolean {
	if (options.signal?.aborted) return false;
	if (result.challenge) return false;
	if (result.tooLarge) return false;
	if (result.status === 0) return isTransientError(result.error ?? "");
	return RETRY_STATUSES.has(result.status);
}
