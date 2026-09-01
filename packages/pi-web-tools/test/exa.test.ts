/**
 * Tests for the Exa adapter (search/api/exa.ts): the keyless MCP path
 * (request shape + SSE/plain-text/JSON-lines parsing — the format-fragile
 * default path) and the keyed SDK param mapping. HTTP is stubbed at the
 * global fetch boundary — installed before exa-js loads so the SDK's
 * captured fetch reference is the stub.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

interface Capture {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

let script: Array<{ status?: number; body?: unknown; text?: string }> = [];
const captures: Capture[] = [];
let call = 0;

// Persistent stub: exa-js captures global.fetch at module load, so install
// this at the top of the file (before the dynamic import below) and swap
// `script` per test.
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
	const step = script[Math.min(call, script.length - 1)] ?? script[0];
	captures.push({
		url: String(input),
		headers: (init?.headers ?? {}) as Record<string, string>,
		body: JSON.parse((init?.body as string) ?? "{}"),
	});
	call++;
	return new Response(step.text ?? JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
}) as typeof fetch;

let exa: typeof import("../search/api/exa.js");
async function loadExa(): Promise<typeof import("../search/api/exa.js")> {
	exa ??= await import("../search/api/exa.js");
	return exa;
}

function withEnv(key: string | undefined, fn: () => Promise<void>): Promise<void> {
	if (key === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = key;
	return fn().finally(() => delete process.env.EXA_API_KEY);
}

function reset(step: (typeof script)[number] | (typeof script)[number][]): void {
	script = Array.isArray(step) ? step : [step];
	captures.length = 0;
	call = 0;
}

/** Wrap a JSON-RPC result in the MCP SSE envelope (data: line). */
function sseRpc(payload: unknown): string {
	return `event: message\ndata: ${JSON.stringify(payload)}\n`;
}

const TEXT_TWO_RESULTS = [
	"Title: One",
	"URL: https://a.com",
	"Published: 2026-08-25",
	"Author: Jane",
	"Highlights:",
	"h1",
	"",
	"Title: Two",
	"URL: https://b.com",
	"Published: N/A",
	"Author: N/A",
].join("\n");

describe("exa adapter — keyless MCP (default path)", () => {
	before(async () => {
		await loadExa();
	});

	it("sends a JSON-RPC tools/call with ONLY query + numResults", async () => {
		await withEnv(undefined, async () => {
			reset({
				text: sseRpc({
					jsonrpc: "2.0",
					id: 1,
					result: { content: [{ type: "text", text: "Title: T\nURL: https://a.com" }] },
				}),
			});
			const { searchWithExa } = await loadExa();
			await searchWithExa({ query: "hello world" }, {});
			const c = captures[0];
			assert.equal(c.url, "https://mcp.exa.ai/mcp");
			assert.equal(c.body.jsonrpc, "2.0");
			assert.equal(c.body.method, "tools/call");
			assert.deepEqual(c.body.params, { name: "web_search_exa", arguments: { query: "hello world", numResults: 5 } });
		});
	});

	it("parses SSE data: lines; plain-text Title/URL blocks → items", async () => {
		await withEnv(undefined, async () => {
			reset({
				text: sseRpc({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: TEXT_TWO_RESULTS }] } }),
			});
			const { searchWithExa } = await loadExa();
			const results = await searchWithExa({ query: "q" }, {});
			assert.equal(results.length, 2);
			assert.equal(results[0].title, "One");
			assert.equal(results[0].url, "https://a.com");
			assert.equal(results[0].snippet, "h1");
			assert.equal(results[0].author, "Jane");
			assert.equal(typeof results[0].pageAge, "string", "published date maps to a relative age");
			assert.equal(results[1].title, "Two");
			assert.equal(results[1].snippet, "");
			assert.equal(results[1].pageAge, undefined, "N/A published is dropped");
			assert.equal(results[1].author, undefined, "N/A author is dropped");
		});
	});

	it("parses the JSON-lines form when blocks are absent", async () => {
		await withEnv(undefined, async () => {
			const jsonLines = [
				JSON.stringify({ title: "J", url: "https://j.com", text: "t", publishedDate: "2026-08-25", author: "A" }),
				"not json, ignored",
			].join("\n");
			reset({ text: sseRpc({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: jsonLines }] } }) });
			const { searchWithExa } = await loadExa();
			const results = await searchWithExa({ query: "q" }, {});
			assert.equal(results.length, 1);
			assert.equal(results[0].url, "https://j.com");
			assert.equal(results[0].snippet, "t");
			assert.equal(results[0].author, "A");
		});
	});

	it("HTTP error → terse message with status", async () => {
		await withEnv(undefined, async () => {
			reset({ status: 429, text: "rate limited" });
			const { searchWithExa } = await loadExa();
			await assert.rejects(() => searchWithExa({ query: "q" }, {}), /Exa MCP error 429/);
		});
	});

	it("RPC error and result.isError both surface as errors", async () => {
		await withEnv(undefined, async () => {
			reset({ text: sseRpc({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }) });
			const { searchWithExa } = await loadExa();
			await assert.rejects(() => searchWithExa({ query: "q" }, {}), /Exa MCP error -32000: boom/);

			reset({
				text: sseRpc({
					jsonrpc: "2.0",
					id: 1,
					result: { isError: true, content: [{ type: "text", text: "tool broke" }] },
				}),
			});
			await assert.rejects(() => searchWithExa({ query: "q" }, {}), /Exa MCP error: tool broke/);
		});
	});

	it("a body with no parseable data: payload errors instead of hanging", async () => {
		await withEnv(undefined, async () => {
			reset({ text: "event: ping\n" });
			const { searchWithExa } = await loadExa();
			await assert.rejects(() => searchWithExa({ query: "q" }, {}), /empty response/);
		});
	});
});

describe("exa adapter — keyed SDK mode", () => {
	before(async () => {
		await loadExa();
	});

	it("maps the full param surface onto the Exa API request", async () => {
		await withEnv("exa-key", async () => {
			reset({ body: { results: [] } });
			const { searchWithExa } = await loadExa();
			await searchWithExa(
				{ query: "q", allowed_domains: ["a.com"], blocked_domains: ["b.com"], recency: "week", locale: "zh-CN" },
				{},
			);
			const c = captures[0];
			assert.ok(c.url.startsWith("https://api.exa.ai/search"), `exa API, got ${c.url}`);
			assert.equal(c.headers["x-api-key"], "exa-key");
			assert.equal(c.body.query, "q");
			assert.equal(c.body.numResults, 5);
			assert.deepEqual(c.body.includeDomains, ["a.com"]);
			assert.deepEqual(c.body.excludeDomains, ["b.com"]);
			assert.equal(typeof c.body.startPublishedDate, "string", "recency maps to a date");
			assert.equal(c.body.userLocation, "CN", "locale maps to Exa's market param");
			assert.deepEqual(c.body.contents, { highlights: true });
		});
	});

	it("maps the response (highlights → snippet, date → pageAge, url filter)", async () => {
		await withEnv("exa-key", async () => {
			reset({
				body: {
					results: [
						{ title: "T", url: "https://t.com", highlights: ["h1", "h2"], publishedDate: "2026-08-25", author: "A" },
						{ title: "no url", highlights: [] },
					],
				},
			});
			const { searchWithExa } = await loadExa();
			const results = await searchWithExa({ query: "q" }, {});
			assert.equal(results.length, 1, "results without url are dropped");
			assert.equal(results[0].snippet, "h1\nh2");
			assert.equal(results[0].author, "A");
			assert.equal(typeof results[0].pageAge, "string");
		});
	});
});
