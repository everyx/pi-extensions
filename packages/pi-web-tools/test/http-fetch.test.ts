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
import { directFetch } from "../fetch/api/http-fetch.js";

interface Captured {
	userAgent?: string;
	accept?: string;
	acceptLanguage?: string;
}

const seen: Captured[] = [];

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
	if (req.url === "/huge-streamed") {
		// No content-length: the cap has to be enforced while reading.
		res.writeHead(200, { "Content-Type": "text/plain" });
		const chunk = "y".repeat(64 * 1024);
		for (let i = 0; i < 8; i++) res.write(chunk);
		res.end();
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
