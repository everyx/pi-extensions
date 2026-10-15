import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type TestContext, test } from "node:test";
import { curlFetch } from "../fetch/api/curl-fetch.js";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("fixture did not settle")), 3_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Native fetch and a loopback socket; the observer only signals reader acquisition. */
async function fixture(t: TestContext, options: { status?: number; headers?: boolean; chunk?: string } = {}) {
	let requests = 0;
	const received = deferred();
	const reading = deferred();
	const closed = deferred();
	let response: import("node:http").ServerResponse | undefined;
	const server = createServer((_, res) => {
		requests++;
		response = res;
		res.on("close", () => closed.resolve());
		if (options.headers !== false) {
			res.writeHead(options.status ?? 200, { "Content-Type": "text/plain" });
			res.write(options.chunk ?? "first-");
		}
		received.resolve();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const nativeFetch = globalThis.fetch;
	const fetchObserver = t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
		const result = await nativeFetch(...args);
		if (result.body) {
			const body = result.body;
			const getReader = body.getReader;
			t.mock.method(body, "getReader", (...readerArgs: unknown[]) => {
				reading.resolve();
				return Reflect.apply(getReader, body, readerArgs);
			});
		}
		return result;
	});
	const previousNoCurl = process.env.PI_WEB_TOOLS_NO_CURL;
	process.env.PI_WEB_TOOLS_NO_CURL = "1";
	t.after(async () => {
		fetchObserver.mock.restore();
		if (previousNoCurl === undefined) delete process.env.PI_WEB_TOOLS_NO_CURL;
		else process.env.PI_WEB_TOOLS_NO_CURL = previousNoCurl;
		response?.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		url,
		received: () => bounded(received.promise),
		reading: () => bounded(reading.promise),
		closed: () => bounded(closed.promise),
		requests: () => requests,
		end: () => response?.end("last"),
		destroy: () => response?.destroy(),
	};
}

test("fallback preserves the complete successful body", async (t) => {
	const server = await fixture(t);
	const pending = curlFetch(server.url);
	await server.reading();
	server.end();
	const result = await bounded(pending);
	assert.equal(result.ok, true);
	assert.equal(Buffer.from(result.bytes ?? []).toString(), "first-last");
});

test("fallback cancels before response headers", async (t) => {
	const server = await fixture(t, { headers: false });
	const controller = new AbortController();
	const pending = curlFetch(server.url, { signal: controller.signal });
	await server.received();
	controller.abort();
	assert.equal((await bounded(pending)).ok, false);
	await server.closed();
});

test("fallback cancels while consuming the body", async (t) => {
	const server = await fixture(t);
	const controller = new AbortController();
	const pending = curlFetch(server.url, { signal: controller.signal });
	await server.reading();
	controller.abort();
	const result = await bounded(pending);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /abort/i);
	assert.doesNotMatch(result.error ?? "", /timed out/i);
	await server.closed();
});

test("fallback timeout covers body consumption", async (t) => {
	const server = await fixture(t);
	const pending = curlFetch(server.url, { timeoutMs: 500 });
	await server.reading();
	const result = await bounded(pending);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /Timed out after 500ms/);
	await server.closed();
});

test("an already cancelled fallback starts no HTTP request", async (t) => {
	const server = await fixture(t);
	const pending = curlFetch(server.url, { signal: AbortSignal.abort() });
	const result = await bounded(pending);
	assert.equal(result.ok, false);
	assert.equal(server.requests(), 0);
});

test("an unread HTTP error body is closed", async (t) => {
	const server = await fixture(t, { status: 404 });
	const result = await bounded(curlFetch(server.url));
	assert.equal(result.ok, false);
	assert.equal(result.status, 404);
	assert.match(result.error ?? "", /404/);
	await server.closed();
});

test("hitting the byte cap closes the body", async (t) => {
	const server = await fixture(t, { chunk: "0123456789" });
	const result = await bounded(curlFetch(server.url, { maxBytes: 4 }));
	assert.equal(result.ok, true);
	assert.equal(result.tooLarge, true);
	assert.equal(result.bytes, null);
	await server.closed();
});

test("a broken body settles with a transport failure", async (t) => {
	const server = await fixture(t);
	const pending = curlFetch(server.url);
	await server.reading();
	server.destroy();
	const result = await bounded(pending);
	assert.equal(result.ok, false);
	assert.ok(result.error);
	await server.closed();
});

test("real curl still cancels an in-flight response", async (t) => {
	const server = await fixture(t);
	delete process.env.PI_WEB_TOOLS_NO_CURL;
	const controller = new AbortController();
	const pending = curlFetch(server.url, { signal: controller.signal });
	await server.received();
	controller.abort();
	const result = await bounded(pending);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /abort/i);
	await server.closed();
});

test("an already cancelled curl request starts no HTTP request", async (t) => {
	const server = await fixture(t);
	delete process.env.PI_WEB_TOOLS_NO_CURL;
	const result = await bounded(curlFetch(server.url, { signal: AbortSignal.abort() }));
	assert.equal(result.ok, false);
	assert.equal(server.requests(), 0);
});
