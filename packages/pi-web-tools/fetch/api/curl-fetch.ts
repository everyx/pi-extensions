/**
 * pi-web-tools — direct-fetch transport: the system curl CLI when present
 * (identity = real curl: TLS fingerprint, UA, header set, HTTP/1.1 — nothing
 * mimicked), with a shallow undici fallback (pinned curl UA) on curl-less
 * systems / PI_WEB_TOOLS_NO_CURL=1. Body flows off curl's stdout under the
 * byte cap; response headers land in a temp file (-D) and are parsed on exit.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWithTimeout } from "../../http.js";

/** UA for the shallow fallback — same identity story as the real curl path. */
const CURL_UA = "curl/8.21.0";

interface CurlFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Body cap; past it the child is killed and the body abandoned unread. */
	maxBytes?: number;
}

interface CurlFetchResult {
	ok: boolean;
	status: number;
	contentType: string;
	bytes: Uint8Array | null;
	tooLarge: boolean;
	error?: string;
}

let curlPresent: boolean | null = null;

/** curl presence probed once (--version) then cached; NO_CURL forces the
 *  shallow fallback (hermetic tests / exotic systems). */
async function curlAvailable(): Promise<boolean> {
	if (process.env.PI_WEB_TOOLS_NO_CURL === "1") return false;
	if (curlPresent !== null) return curlPresent;
	curlPresent = await new Promise<boolean>((resolve) => {
		const child = spawn("curl", ["--version"], { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, 3000);
		child.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
	return curlPresent;
}

/** curl(1) exit codes worth a human word (the rest fall back to stderr). */
const CURL_EXIT_MESSAGES: Record<number, string> = {
	6: "couldn't resolve host",
	7: "failed to connect",
	26: "read error while downloading",
	28: "operation timed out",
	52: "empty reply from server",
	56: "failure receiving network data",
};

function concatChunks(chunks: Buffer[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function curlSubprocess(url: string, options: CurlFetchOptions): Promise<CurlFetchResult> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
	const dir = await mkdtemp(join(tmpdir(), "pi-curl-"));
	const headerFile = join(dir, "headers");

	// -D writes raw response headers (all redirect blocks) to the temp file;
	// --compressed asks for and DECODES br/gzip/deflate/zstd, so stdout is
	// the plain body. No -f: 4xx/5xx arrive as real responses, not errors.
	const child = spawn(
		"curl",
		[
			"-sS",
			"-L",
			"--max-redirs",
			"5",
			"--compressed",
			"--max-time",
			(timeoutMs / 1000).toFixed(1),
			"-D",
			headerFile,
			url,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + String(chunk)).slice(-2000);
	});

	return await new Promise<CurlFetchResult>((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		let killedForAbort = false;

		const onAbort = () => {
			killedForAbort = true;
			child.kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			if (tooLarge) return;
			size += chunk.length;
			if (size > maxBytes) {
				tooLarge = true;
				child.kill();
				return;
			}
			chunks.push(chunk);
		});

		child.on("error", (err) => {
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ ok: false, status: 0, contentType: "", bytes: null, tooLarge: false, error: `curl: ${err.message}` });
		});

		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", onAbort);
			void (async () => {
				try {
					let status = 0;
					let contentType = "";
					let reasonPhrase = "";
					try {
						const headers = await readFile(headerFile, "utf-8");
						// trimEnd first: curl may terminate the -D output with a
						// trailing CRLF whose split would leave a phantom "" block.
						const last = headers.trimEnd().split("\r\n\r\n").at(-1) ?? "";
						const statusLine = /^HTTP\/\S+ (\d{3})(?: ([^\r\n]*))?/.exec(last);
						status = Number(statusLine?.[1] ?? 0);
						reasonPhrase = statusLine?.[2] ?? "";
						contentType = /^content-type: (.*)$/im.exec(last)?.[1] ?? "";
					} catch {}
					if (killedForAbort) {
						resolve({ ok: false, status: 0, contentType: "", bytes: null, tooLarge: false, error: "fetch aborted" });
					} else if (tooLarge) {
						resolve({ ok: true, status, contentType, bytes: null, tooLarge: true });
					} else if (code === 0 && status >= 200 && status < 300) {
						resolve({ ok: true, status, contentType, bytes: concatChunks(chunks), tooLarge: false });
					} else if (code === 0) {
						// curl exits 0 even for 4xx/5xx (no -f) — the status line
						// decides: parity with the old response.ok semantics.
						resolve({
							ok: false,
							status,
							contentType,
							bytes: null,
							tooLarge: false,
							error: `HTTP ${status}: ${reasonPhrase}`.trim(),
						});
					} else {
						const reason = (CURL_EXIT_MESSAGES[code ?? 0] ?? stderr.trim()) || `exit code ${code}`;
						resolve({
							ok: false,
							status,
							contentType,
							bytes: null,
							tooLarge: false,
							error: `curl: (${code}) ${reason}`,
						});
					}
				} finally {
					void rm(dir, { recursive: true, force: true });
				}
			})();
		});
	});
}

/** Stream a Response body under cap; null signals the cap was hit. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			void reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/** Shallow curl identity on undici (no curl binary): pinned curl UA and a
 *  wildcard Accept, everything else Node defaults. */
async function fallbackFetch(url: string, options: CurlFetchOptions): Promise<CurlFetchResult> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
	try {
		const response = await fetchWithTimeout(
			url,
			{ headers: { "User-Agent": CURL_UA, Accept: "*/*" } },
			{ signal: options.signal, timeoutMs },
		);
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				contentType,
				bytes: null,
				tooLarge: false,
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}
		const bytes = await readBodyCapped(response, maxBytes);
		return { ok: true, status: response.status, contentType, bytes, tooLarge: bytes === null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = (err as { cause?: { code?: string } }).cause?.code;
		return {
			ok: false,
			status: 0,
			contentType: "",
			bytes: null,
			tooLarge: false,
			error: code ? `${message} (${code})` : message,
		};
	}
}

/** Direct-fetch transport: real curl via subprocess, shallow fallback after. */
export async function curlFetch(url: string, options: CurlFetchOptions = {}): Promise<CurlFetchResult> {
	return (await curlAvailable()) ? curlSubprocess(url, options) : fallbackFetch(url, options);
}
