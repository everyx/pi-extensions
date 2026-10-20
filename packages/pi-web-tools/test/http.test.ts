/**
 * The response lifetime: a deadline and a cancellation must outlive the
 * headers.
 *
 * Every case runs against a loopback server — no network, no keys. The server
 * sends headers immediately and then trickles the body, which is exactly the
 * shape that used to slip out of the supervision: `fetch()` resolves at the
 * headers, and everything after that ran with no timer and no abort signal.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { fetchWithTimeout } from "../http.js";

/** Headers now, then one small chunk every `tickMs` until the client leaves. */
async function trickleServer(opts: { tickMs?: number; chunks?: number } = {}) {
	const tickMs = opts.tickMs ?? 50;
	const chunks = opts.chunks ?? 40;
	let requests = 0;
	const server = http.createServer((_req, res) => {
		requests++;
		res.writeHead(200, { "content-type": "text/plain" });
		let sent = 0;
		const timer = setInterval(() => {
			if (sent++ >= chunks) {
				clearInterval(timer);
				res.end();
				return;
			}
			res.write(`chunk${sent}\n`);
		}, tickMs);
		res.on("close", () => clearInterval(timer));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	return {
		url,
		requests: () => requests,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

const servers: Array<() => void> = [];
after(() => {
	for (const close of servers) close();
});

async function serve(opts?: { tickMs?: number; chunks?: number }) {
	const s = await trickleServer(opts);
	servers.push(s.close);
	return s;
}

describe("fetchWithTimeout — the deadline covers the body, not just the headers", () => {
	it("a full response still reads normally", async () => {
		const s = await serve({ tickMs: 1, chunks: 3 });
		const response = await fetchWithTimeout(s.url, {}, {});
		assert.equal(await response.text(), "chunk1\nchunk2\nchunk3\n");
	});

	it("cancelling after the headers aborts the body read", async () => {
		const s = await serve();
		const controller = new AbortController();
		const response = await fetchWithTimeout(s.url, {}, { signal: controller.signal });

		// Headers are in — this is exactly where the old supervision ended.
		const reader = response.body?.getReader();
		assert.ok(reader);
		const first = await reader.read();
		assert.equal(first.done, false);

		controller.abort();
		await assert.rejects(
			() => reader.read(),
			(e: Error) => e.name === "AbortError",
			"the body must stop when the caller cancels, not keep streaming",
		);
	});

	it("the timeout fires while the body is still streaming", async () => {
		// Generous headroom for the headers phase (loopback, but the suite runs in
		// parallel): the deadline has to land while the body trickles, not before
		// the response exists.
		const s = await serve({ tickMs: 150, chunks: 100 });
		const response = await fetchWithTimeout(s.url, {}, { timeoutMs: 400 });
		// Note the text: the headers phase throws our "Timed out after Nms", but a
		// body that is already streaming rejects with the platform's TimeoutError.
		// Both are bounded by the same deadline — that is the property under test.
		await assert.rejects(
			() => response.text(),
			/timeout/i,
			"a slow body must be bounded by the same deadline as the headers",
		);
	});

	it("an already-cancelled call never reaches the server", async () => {
		const s = await serve();
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(() => fetchWithTimeout(s.url, {}, { signal: controller.signal }));
		assert.equal(s.requests(), 0, "no request may be started after cancellation");
	});
});
