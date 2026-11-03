/**
 * Integration tests for the fetch fuse, driven through `webFetch` rather than
 * the adapters directly — the chain only earns its keep if what the adapters
 * report actually reaches the caller.
 *
 * The bug these pin down: `rendererFailures` existed on the result type but was
 * dropped on both the success path (a renderer failed, the next one worked) and
 * the error path (every renderer failed) — i.e. in exactly the two situations
 * where someone would go looking for it.
 *
 * Hermetic by rule: a local server plays the "direct curl" role, and global
 * fetch is stubbed for the renderer calls. No real sites, no keys.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { webFetch } from "../fetch/fetch.js";
import { fetchToolResult } from "../index.js";
import { withEnvVars } from "./env.js";

const listener = createServer((req, res) => {
	if (req.url === "/wall") {
		// An anti-bot wall: the direct fetch fails in a way rendering can fix.
		res.writeHead(403, { "Content-Type": "text/html" });
		res.end("<html><body>Access denied</body></html>");
		return;
	}
	if (req.url === "/csr") {
		// A CSR shell: no readable markup, framework markers only. Rendering is
		// the only way to get content, so a failed render is the interesting case.
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
		return;
	}
	if (req.url === "/gone") {
		// A page that genuinely does not exist — the fuse must stay out of it.
		res.writeHead(404, { "Content-Type": "text/html" });
		res.end("not here");
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html" });
	res.end("<html><head><title>Fine</title></head><body><p>direct body</p></body></html>");
});

// The shell may export TINYFISH_API_KEY; these tests assume which renderers are
// configured, so start from absent and restore the real values afterwards.
const originalTinyfishKey = process.env.TINYFISH_API_KEY;
before(() => {
	delete process.env.TINYFISH_API_KEY;
});

let base = "";
before(async () => {
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
after(() => {
	if (originalTinyfishKey === undefined) delete process.env.TINYFISH_API_KEY;
	else process.env.TINYFISH_API_KEY = originalTinyfishKey;
	return new Promise<void>((resolve) => listener.close(() => resolve()));
});

interface RendererCall {
	status: number;
	markdown?: string;
}

/** Stub the renderer transport. `curl` still runs for real against the local
 *  server above — this only replaces what firecrawl/tinyfish answer. */
function stubRenderers(plan: { firecrawl?: RendererCall; tinyfish?: RendererCall }): void {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.href);
		void init;
		if (url.hostname.includes("firecrawl")) {
			const call = plan.firecrawl;
			if (!call) return new Response("{}", { status: 500 });
			return new Response(JSON.stringify({ success: true, data: { markdown: call.markdown } }), {
				status: call.status,
			});
		}
		const call = plan.tinyfish;
		if (!call) return new Response("{}", { status: 401 });
		return new Response(JSON.stringify({ results: [{ text: call.markdown }] }), { status: call.status });
	}) as typeof fetch;
}

describe("web_fetch fuse — the diagnosis survives to the caller", () => {
	it("renders a walled page through the first renderer that answers", async () => {
		stubRenderers({ firecrawl: { status: 200, markdown: "# Rescued\n\nbody" } });

		const result = await webFetch(`${base}/wall`);

		assert.equal(result.error, undefined);
		assert.match(result.content, /Rescued/, "the renderer's text is what the caller gets");
		assert.equal(result.renderer, "firecrawl");
		assert.equal(result.renderReason, "http-failed");
	});

	it("keeps the earlier failure when a later renderer succeeds", async () => {
		// Firecrawl refuses (anonymous access withdrawn, quota, whatever): the
		// chain must continue, and the refusal must not vanish on success.
		await withEnvVars({ TINYFISH_API_KEY: "test-key" }, async () => {
			stubRenderers({
				firecrawl: { status: 401 },
				tinyfish: { status: 200, markdown: "# Second\n\nbody" },
			});

			const result = await webFetch(`${base}/wall`);

			assert.equal(result.renderer, "tinyfish", "the chain advanced past the refusal");
			assert.deepEqual(result.rendererFailures, ["firecrawl: HTTP 401"], "the refusal is still on the record");
		});
	});

	it("reports every renderer's reason when none of them delivers", async () => {
		stubRenderers({ firecrawl: { status: 401 } });

		const result = await webFetch(`${base}/wall`);

		assert.ok(result.error, "a failed fetch says so");
		const failures = result.rendererFailures ?? [];
		assert.ok(failures.length > 0, "the card can say why nothing rendered");
		assert.ok(
			failures.some((f) => f.startsWith("firecrawl:")),
			`firecrawl's refusal is recorded (got ${JSON.stringify(failures)})`,
		);
		assert.ok(
			failures.some((f) => f.includes("no credentials")),
			"a renderer skipped for a missing key says that, not 'no content'",
		);
	});

	it("does not spend the fuse on a page that is simply gone", async () => {
		let rendererCalls = 0;
		globalThis.fetch = (async () => {
			rendererCalls++;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		const result = await webFetch(`${base}/gone`);

		assert.ok(result.error, "404 is reported honestly");
		assert.equal(rendererCalls, 0, "404 is not something a renderer can fix");
		assert.equal(result.rendererFailures, undefined);
	});
});

describe("web_fetch fuse — the CSR entry point reports the same diagnosis", () => {
	it("keeps the renderer reasons when a CSR page cannot be rendered", async () => {
		stubRenderers({ firecrawl: { status: 401 } });

		const result = await webFetch(`${base}/csr`);

		assert.match(String(result.error), /JavaScript-rendered|no readable content/);
		const failures = result.rendererFailures ?? [];
		assert.ok(
			failures.some((f) => f.startsWith("firecrawl:")),
			`the CSR path keeps what the fuse said (got ${JSON.stringify(failures)})`,
		);
	});
});

describe("fetchToolResult — the diagnostics reach the card, not just the caller", () => {
	it("carries renderer, reason and earlier failures on a rendered page", () => {
		const shaped = fetchToolResult(
			{
				title: "T",
				content: "body",
				renderer: "tinyfish",
				renderReason: "csr-shell",
				rendererFailures: ["firecrawl: HTTP 401"],
			},
			"https://a.dev",
			1,
		);

		const data = (shaped.details as { data?: Record<string, unknown> }).data ?? {};
		assert.equal(data.renderer, "tinyfish");
		assert.equal(data.renderReason, "csr-shell");
		assert.deepEqual(data.rendererFailures, ["firecrawl: HTTP 401"]);
		assert.equal(shaped.isError, false);
	});

	it("carries the failures on the error path — where someone will look", () => {
		const shaped = fetchToolResult(
			{ title: "", content: "", error: "Failed to fetch", rendererFailures: ["firecrawl: HTTP 401"] },
			"https://a.dev",
			1,
		);

		assert.equal(shaped.isError, true);
		assert.deepEqual((shaped.details as { rendererFailures?: string[] }).rendererFailures, ["firecrawl: HTTP 401"]);
		assert.equal((shaped.details as { error?: string }).error, "Failed to fetch");
	});

	it("leaves the field absent on a direct fetch — nothing was refused", () => {
		const shaped = fetchToolResult({ title: "T", content: "body" }, "https://a.dev", 1);
		const data = (shaped.details as { data?: Record<string, unknown> }).data ?? {};
		assert.equal(data.renderer, undefined);
		assert.equal(data.rendererFailures, undefined);
	});
});

describe("web_fetch fuse — a renderer can be walled too", () => {
	it("refuses a renderer's block page instead of passing it off as content", async () => {
		// Firecrawl answering 200 with "Blocked by network security" as clean
		// markdown is still a refusal; reporting it as the page is how a wall
		// reaches the model wearing a success status.
		stubRenderers({ firecrawl: { status: 200, markdown: "# Blocked by network security\n\nContact us." } });

		const result = await webFetch(`${base}/wall`);

		assert.ok(result.error, "the caller is told it failed");
		assert.equal(result.content, "");
		assert.ok(
			(result.rendererFailures ?? []).some((f) => f.includes("network block page")),
			`the wall is on the record (got ${JSON.stringify(result.rendererFailures)})`,
		);
	});
});
