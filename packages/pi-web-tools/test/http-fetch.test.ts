/**
 * Tests for the direct transport (fetch/api/http-fetch.ts).
 *
 * Two things are being pinned here: what we send (the headers are the whole
 * point of this change) and how every failure leaves the transport (normalized,
 * never thrown) — the rendering fuse above depends on being able to tell "the
 * page said 404" from "the socket died".
 *
 * A real local server receives the requests, so the assertions are about what
 * actually goes on the wire, not about an argument object.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { directFetch, redirectRefusal, upgradeToHttps } from "../fetch/api/http-fetch.js";

interface Captured {
	userAgent?: string;
	accept?: string;
	acceptLanguage?: string;
}

const seen: Captured[] = [];
let flakyCalls = 0;
let challengeCalls = 0;

const listener = createServer((req, res) => {
	if (req.url === "/page") {
		seen.push({
			userAgent: req.headers["user-agent"],
			accept: req.headers.accept,
			acceptLanguage: req.headers["accept-language"],
		});
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<html><body><p>hello</p></body></html>");
		return;
	}
	if (req.url === "/gone") {
		res.writeHead(404, { "Content-Type": "text/html" });
		res.end("nope");
		return;
	}
	if (req.url === "/huge-declared") {
		// Announces more than the cap: the transport must not read the body.
		res.writeHead(200, { "Content-Length": String(10 * 1024 * 1024), "Content-Type": "text/plain" });
		res.end("x");
		return;
	}
	if (req.url === "/missing-huge") {
		// A 404 that also announces an oversized body: still a 404.
		res.writeHead(404, { "Content-Length": String(10 * 1024 * 1024), "Content-Type": "text/html" });
		res.end("not found");
		return;
	}
	if (req.url === "/huge-streamed") {
		// No content-length: the cap has to be enforced while reading.
		res.writeHead(200, { "Content-Type": "text/plain" });
		const chunk = "y".repeat(64 * 1024);
		for (let i = 0; i < 8; i++) res.write(chunk);
		res.end();
		return;
	}
	if (req.url === "/flaky") {
		// Fails twice, then answers: the retry budget should be enough.
		flakyCalls++;
		if (flakyCalls < 3) {
			res.writeHead(503, { "Content-Type": "text/plain" });
			res.end("upstream hiccup");
			return;
		}
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("finally");
		return;
	}
	if (req.url === "/challenge") {
		// Cloudflare's unambiguous signal: do not retry it.
		challengeCalls++;
		res.writeHead(403, { "cf-mitigated": "challenge", "Content-Type": "text/html" });
		res.end("<html><body>blocked</body></html>");
		return;
	}
	if (req.url === "/challenge-huge") {
		// A wall whose body is genuinely large: the prefix is what matters, and
		// only the prefix is read.
		const body = `<html><head><title>Just a moment...</title></head><body>Checking your browser${"x".repeat(200_000)}</body></html>`;
		res.writeHead(403, { "Content-Length": String(body.length), "Content-Type": "text/html" });
		res.end(body);
		return;
	}
	if (req.url === "/challenge-body") {
		// A wall that only the body gives away.
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>");
		return;
	}
	if (req.url === "/r1") {
		res.writeHead(302, { Location: "/r2" });
		res.end();
		return;
	}
	if (req.url === "/r2") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("after two hops");
		return;
	}
	if (req.url === "/loop") {
		res.writeHead(302, { Location: "/loop" });
		res.end();
		return;
	}
	if (req.url === "/body-reset") {
		// Headers look fine, then the connection dies mid-body.
		res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "1024" });
		res.write("partial");
		setTimeout(() => res.socket?.destroy(), 10);
		return;
	}
	if (req.url === "/wall-hangs") {
		// Headers (403) arrive, then the body never finishes: a wall check must
		// not turn that into "HTTP 403".
		res.writeHead(403, { "Content-Type": "text/html", "Content-Length": "1000" });
		res.write("<html><head>");
		// never end
		return;
	}
	if (req.url === "/slow") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		setTimeout(() => res.end("late"), 2_000);
		return;
	}
	res.writeHead(200, { "Content-Type": "text/markdown" });
	res.end("markdown body");
});

let base = "";
before(async () => {
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => listener.close(() => resolve())));

describe("directFetch — what the request carries", () => {
	it("sends a product UA, an Accept that prefers markdown, and a language", async () => {
		const result = await directFetch(`${base}/page`);
		assert.equal(result.ok, true);

		const last = seen.at(-1);
		assert.match(
			String(last?.userAgent),
			/^Mozilla\/5\.0 \(compatible; pi-web-tools[\d./]*; \+https:\/\/github\.com\/everyx\/pi-extensions\)$/,
		);
		assert.match(String(last?.accept), /^text\/markdown,/, "markdown first by default");
		assert.equal(last?.acceptLanguage, "en-US,en;q=0.9");
	});

	it("flips the Accept order for raw, which wants the source", async () => {
		await directFetch(`${base}/page`, { format: "html" });
		assert.match(String(seen.at(-1)?.accept), /^text\/html/, "html first when the caller asked for source");
	});

	it("honours a markdown response as the caller's format", async () => {
		const result = await directFetch(`${base}/md`);
		assert.equal(result.contentType, "text/markdown");
		assert.equal(new TextDecoder().decode(result.bytes ?? new Uint8Array()), "markdown body");
	});
});

describe("directFetch — every failure is a result, not a throw", () => {
	it("reports a 404 with its status and content type", async () => {
		const result = await directFetch(`${base}/gone`);
		assert.equal(result.ok, false);
		assert.equal(result.status, 404);
		assert.equal(result.contentType, "text/html");
		assert.match(String(result.error), /^HTTP 404/);
	});

	it("refuses a declared content-length beyond the cap without reading it", async () => {
		const result = await directFetch(`${base}/huge-declared`, { maxBytes: 1024 });
		assert.equal(result.ok, true);
		assert.equal(result.tooLarge, true);
		assert.equal(result.bytes, null);
	});

	it("stops a stream that runs past the cap", async () => {
		const result = await directFetch(`${base}/huge-streamed`, { maxBytes: 32 * 1024 });
		assert.equal(result.tooLarge, true);
		assert.equal(result.bytes, null);
	});

	it("reports a timeout instead of hanging", async () => {
		const result = await directFetch(`${base}/slow`, { timeoutMs: 150 });
		assert.equal(result.ok, false);
		assert.match(String(result.error), /timed out/);
	});

	it("distinguishes a cancelled call from a failed one", async () => {
		const controller = new AbortController();
		const pending = directFetch(`${base}/slow`, { signal: controller.signal, timeoutMs: 5_000 });
		controller.abort();
		const result = await pending;
		assert.equal(result.error, "fetch aborted");
	});

	it("names a refused connection instead of 'fetch failed'", async () => {
		// A high, closed port: undici surfaces ECONNREFUSED, which the transport
		// turns into words a model can act on.
		const result = await directFetch("http://127.0.0.1:45999/", { timeoutMs: 3_000 });
		assert.equal(result.ok, false);
		assert.equal(result.error, "connection refused");
	});
});

describe("directFetch — retry only what a retry can fix", () => {
	it("rides out a transient 503 and reports how many attempts it took", async () => {
		flakyCalls = 0;
		const result = await directFetch(`${base}/flaky`, { timeoutMs: 8_000 });
		assert.equal(result.ok, true);
		assert.equal(new TextDecoder().decode(result.bytes ?? new Uint8Array()), "finally");
		assert.equal(result.attempts, 3, "two failures then success");
	});

	it("does not retry a challenge — it is stable across attempts", async () => {
		challengeCalls = 0;
		const result = await directFetch(`${base}/challenge`, { timeoutMs: 8_000 });
		assert.equal(result.ok, false);
		assert.equal(result.challenge, "Cloudflare");
		assert.match(String(result.error), /blocked by a Cloudflare challenge/);
		assert.equal(result.attempts, 1, "one request, not three");
		assert.equal(challengeCalls, 1);
	});

	it("recognises a challenge that only the body reveals", async () => {
		const result = await directFetch(`${base}/challenge-body`, { timeoutMs: 5_000 });
		assert.equal(result.ok, false);
		assert.equal(result.challenge, "Cloudflare");
		assert.equal(result.attempts, 1);
	});

	it("does not retry a plain 404 — the page is not there", async () => {
		const result = await directFetch(`${base}/gone`, { timeoutMs: 5_000 });
		assert.equal(result.status, 404);
		assert.equal(result.attempts, 1);
	});

	it("spends one attempt when the first one works", async () => {
		const result = await directFetch(`${base}/page`, { timeoutMs: 5_000 });
		assert.equal(result.attempts, 1);
	});
});

describe("directFetch — the redirect chain is walked and reported", () => {
	it("follows a chain and records every hop", async () => {
		const result = await directFetch(`${base}/r1`);
		assert.equal(result.ok, true);
		assert.equal(new TextDecoder().decode(result.bytes ?? new Uint8Array()), "after two hops");
		assert.equal(result.finalUrl, `${base}/r2`);
		assert.deepEqual(
			result.redirects?.map((h) => [h.status, new URL(h.to).pathname]),
			[[302, "/r2"]],
		);
	});

	it("refuses a public page's redirect into a private address", () => {
		// The decision is unit-tested rather than driven through the server: the
		// test server itself lives on 127.0.0.1, which is inside the trust domain
		// the rule deliberately allows.
		assert.match(String(redirectRefusal(false, new URL("http://127.0.0.1:8080/admin"))), /private address refused/);
		assert.match(String(redirectRefusal(false, new URL("http://169.254.169.254/latest"))), /private address refused/);
		assert.match(String(redirectRefusal(false, new URL("http://[::1]:8080/"))), /private address refused/);
	});

	it("lets a local caller follow its own local redirects", () => {
		// Talking to a dev server means its redirects stay in that same domain.
		assert.equal(redirectRefusal(true, new URL("http://127.0.0.1:8080/next")), undefined);
		assert.equal(redirectRefusal(false, new URL("https://example.com/next")), undefined);
	});

	it("gives up on a loop instead of spinning", async () => {
		const result = await directFetch(`${base}/loop`, { timeoutMs: 5_000 });
		assert.equal(result.ok, false);
		assert.match(String(result.error), /too many redirects/);
	});

	it("rejects a bare hostname — that is what bash curl is for", async () => {
		const result = await directFetch("http://localhost:3000/");
		assert.equal(result.ok, false);
		assert.match(String(result.error), /without a dot/);
	});
});

describe("directFetch — the contract holds on the way out too", () => {
	it("turns a mid-body connection reset into a result, not a throw", async () => {
		// The failure the rendering fuse exists for: it must reach the caller as
		// a result, or the fuse never gets a chance to run.
		const result = await directFetch(`${base}/body-reset`, { timeoutMs: 5_000 });
		assert.equal(result.ok, false);
		assert.ok(result.error, "an error string, not an exception");
		assert.ok((result.attempts ?? 0) >= 1);
	});

	it("refuses a malformed URL instead of throwing on it", async () => {
		const result = await directFetch("http://[");
		assert.equal(result.ok, false);
		assert.match(String(result.error), /invalid URL/);
	});

	it("only follows an upgrade decision for public http hosts", () => {
		assert.equal(upgradeToHttps("http://example.com/a"), "https://example.com/a");
		assert.equal(upgradeToHttps("https://example.com/a"), undefined);
		assert.equal(upgradeToHttps("http://127.0.0.1:8080/a"), undefined, "a dev server is not upgraded");
		assert.equal(upgradeToHttps("http://intranet/a"), undefined, "a bare hostname is not upgraded");
		assert.equal(upgradeToHttps("not a url"), undefined);
	});

	it("treats IPv6 link-local as private on redirect", () => {
		assert.match(String(redirectRefusal(false, new URL("http://[fe80::1]/"))), /private address refused/);
		assert.match(String(redirectRefusal(false, new URL("http://[fe80::abcd]/"))), /private address refused/);
	});
});

describe("directFetch — status beats size", () => {
	it("reports a 404 even when its body is over the cap", async () => {
		const result = await directFetch(`${base}/missing-huge`, { maxBytes: 1024 });
		assert.equal(result.ok, false, "a missing page is not a successful oversized one");
		assert.equal(result.status, 404);
		assert.match(String(result.error), /^HTTP 404/);
	});

	it("still reports a successful oversized body as ok + tooLarge", async () => {
		const result = await directFetch(`${base}/huge-declared`, { maxBytes: 1024 });
		assert.equal(result.ok, true);
		assert.equal(result.tooLarge, true);
		assert.equal(result.bytes, null);
	});
});

describe("redirectRefusal — IPv6 in disguise", () => {
	it("treats an IPv4-mapped IPv6 address as what it maps to", () => {
		assert.match(String(redirectRefusal(false, new URL("http://[::ffff:127.0.0.1]/"))), /private address refused/);
		assert.match(
			String(redirectRefusal(false, new URL("http://[::ffff:169.254.169.254]/"))),
			/private address refused/,
		);
		assert.equal(
			redirectRefusal(false, new URL("http://[::ffff:93.184.216.34]/")),
			undefined,
			"a public v4 stays public",
		);
	});
});

describe("directFetch — a wall is recognised even when it claims to be big", () => {
	it("sniffs the prefix of an oversized error response", async () => {
		// The declared length is 1 MB; skipping the read would leave this as a
		// plain HTTP 403 and send the caller to a renderer it may not need.
		const result = await directFetch(`${base}/challenge-huge`, { timeoutMs: 5_000 });
		assert.equal(result.ok, false);
		assert.equal(result.challenge, "Cloudflare");
		assert.equal(result.attempts, 1, "and it is not retried");
	});
});

describe("directFetch — sniffing a wall must not swallow the clock", () => {
	it("reports the timeout, not the 403, when the wall page never finishes", async () => {
		const result = await directFetch(`${base}/wall-hangs`, { timeoutMs: 200 });
		assert.equal(result.ok, false);
		assert.match(String(result.error), /timed out/, `got: ${result.error}`);
	});

	it("reports cancellation, not the 403, when the caller gives up mid-body", async () => {
		const controller = new AbortController();
		const pending = directFetch(`${base}/wall-hangs`, { signal: controller.signal, timeoutMs: 5_000 });
		setTimeout(() => controller.abort(), 50);
		const result = await pending;
		assert.equal(result.error, "fetch aborted");
	});
});
