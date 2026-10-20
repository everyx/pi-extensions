/**
 * Transport tests for the direct-fetch layer (fetch/api/curl-fetch.ts):
 * the real-curl subprocess path (identity assertions: UA / Accept / HTTP/1.1
 * all observed server-side) and the shallow undici fallback (NO_CURL). All
 * traffic stays on a local server — hermetic by rule.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { curlFetch } from "../fetch/api/curl-fetch.js";

let base = "";
const signatures: Array<{ ua?: string; accept?: string; httpVersion: string }> = [];

const listener = createServer((req, res) => {
	signatures.push({
		ua: req.headers["user-agent"],
		accept: req.headers.accept,
		httpVersion: req.httpVersion,
	});
	if (req.url === "/reset") {
		res.destroy();
		return;
	}
	res.writeHead(req.url === "/404" ? 404 : 200, { "Content-Type": "text/html" });
	res.end("<html><body><h1>Transport Marker</h1></body></html>");
});

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return fn().finally(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

before(async () => {
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => listener.close(() => resolve())));

/** Headers plus one chunk now, the rest held open — the shape where the
 *  response outlives `fetch()`. `status` swaps in the error-body variant. */
async function slowServer(opts: { status?: number; end?: boolean; chunk?: string } = {}) {
	let requests = 0;
	let closedResolve!: () => void;
	const closed = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});
	let firstChunkResolve!: () => void;
	const firstChunk = new Promise<void>((resolve) => {
		firstChunkResolve = resolve;
	});
	const server = createServer((_req, res) => {
		requests++;
		res.on("close", () => closedResolve());
		res.writeHead(opts.status ?? 200, { "content-type": "text/plain" });
		res.write(opts.chunk ?? "first-");
		firstChunkResolve();
		if (opts.end) res.end("last");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		requests: () => requests,
		firstChunk: () => firstChunk,
		// Reject rather than resolve on timeout: "the connection was released" is a
		// claim, and a test that passes when nothing happened proves nothing.
		destroy: () => server.closeAllConnections(),
		closed: () =>
			Promise.race([
				closed,
				new Promise((_, reject) => setTimeout(() => reject(new Error("connection was not released")), 1_000)),
			]),
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

describe("direct fetch — cancellation", () => {
	it("an already-cancelled call never probes for curl or opens a socket", async () => {
		const controller = new AbortController();
		controller.abort();
		const before = signatures.length;

		const result = await curlFetch(`${base}/text`, { signal: controller.signal });

		assert.equal(result.ok, false);
		assert.equal(result.error, "fetch aborted");
		assert.equal(signatures.length, before, "the server must not see a request");
	});
});

describe("direct fetch — real curl subprocess (identity = curl)", () => {
	it("requests look like curl server-side: UA prefix, wildcard Accept, HTTP/1.1", async () => {
		const r = await curlFetch(`${base}/`);
		assert.equal(r.ok, true);
		assert.ok(r.bytes && Buffer.from(r.bytes).toString().includes("Transport Marker"));
		assert.ok(r.contentType.includes("text/html"), `contentType: ${r.contentType}`);

		const sig = signatures.at(-1);
		assert.ok(sig, "server observed the request");
		assert.match(sig.ua ?? "", /^curl\//, `UA is curl's own: ${sig.ua}`);
		assert.equal(sig.accept, "*/*", "wildcard Accept — no md negotiation claim");
		assert.equal(sig.httpVersion, "1.1", "curl speaks HTTP/1.1 by default");
	});

	it("4xx arrives as a real response (status + error), not a transport failure", async () => {
		const r = await curlFetch(`${base}/404`);
		assert.equal(r.ok, false);
		assert.equal(r.status, 404);
		assert.match(r.error ?? "", /404/);
	});

	it("socket reset maps to the curl typed error (exit 52)", async () => {
		const r = await curlFetch(`${base}/reset`);
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /curl: \(52\)|empty reply/i, `got: ${r.error}`);
	});
});

describe("direct fetch — shallow fallback (PI_WEB_TOOLS_NO_CURL=1)", () => {
	it("undici transport but the curl identity story is kept", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const r = await curlFetch(`${base}/`);
			assert.equal(r.ok, true);
			assert.ok(r.bytes && Buffer.from(r.bytes).toString().includes("Transport Marker"));

			const sig = signatures.at(-1);
			assert.equal(sig?.ua, "curl/8.21.0", "pinned curl UA on the fallback");
			assert.equal(sig?.accept, "*/*");
		}));

	it("4xx maps the same way as the curl path", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const r = await curlFetch(`${base}/404`);
			assert.equal(r.ok, false);
			assert.equal(r.status, 404);
			assert.match(r.error ?? "", /404/);
		}));

	it("a cancelled body read is a cancellation, not a timeout", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const trickle = await slowServer();
			try {
				const controller = new AbortController();
				const pending = curlFetch(trickle.url, { signal: controller.signal });
				await trickle.firstChunk();
				controller.abort();
				const r = await pending;
				assert.equal(r.ok, false);
				assert.match(r.error ?? "", /abort/i);
				assert.doesNotMatch(r.error ?? "", /timed out/i, "a cancel must not be reported as a deadline");
			} finally {
				trickle.close();
			}
		}));

	it("the deadline covers the body, in one message", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const trickle = await slowServer();
			try {
				const r = await curlFetch(trickle.url, { timeoutMs: 300 });
				assert.equal(r.ok, false);
				assert.match(r.error ?? "", /Timed out after 300ms/);
			} finally {
				trickle.close();
			}
		}));

	it("hitting the byte cap stops the transfer and closes the body", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const server = await slowServer({ chunk: "0123456789" });
			try {
				const r = await curlFetch(server.url, { maxBytes: 4 });
				assert.equal(r.ok, true);
				assert.equal(r.tooLarge, true);
				assert.equal(r.bytes, null);
				await server.closed();
			} finally {
				server.close();
			}
		}));

	it("a body that breaks mid-stream is a transport failure", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const server = await slowServer();
			try {
				const pending = curlFetch(server.url);
				await server.firstChunk();
				server.destroy();
				const r = await pending;
				assert.equal(r.ok, false);
				assert.ok(r.error, "the failure carries a reason");
			} finally {
				server.close();
			}
		}));

	it("an unread error body releases the connection", () =>
		withEnv({ PI_WEB_TOOLS_NO_CURL: "1" }, async () => {
			const server = await slowServer({ status: 404 });
			try {
				await curlFetch(server.url);
				await server.closed();
			} finally {
				server.close();
			}
		}));
});
