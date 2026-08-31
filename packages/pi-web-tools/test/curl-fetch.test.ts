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
});
