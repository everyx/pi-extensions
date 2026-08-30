/**
 * pi-web-tools — Exa channel.
 *
 * Dual mode (SPEC: Exa MCP 零配置 + API key 双模):
 *   - no EXA_API_KEY  → MCP endpoint (mcp.exa.ai, JSON-RPC web_search_exa).
 *     The official exa-js SDK requires an API key, so this mode stays on a
 *     hand-rolled MCP call (SSE response). Free tier: 3 qps / 150 calls/day;
 *     bare queries only (query + numResults) — gated by exaSupports().
 *   - with key        → official SDK (exa-js), full param surface incl.
 *     userLocation (Exa's market param — the Bing mkt/cc equivalent per
 *     exa's own migration guide).
 */

import Exa from "exa-js";
import { isoToRelativeAge } from "../../date.js";
import { fetchWithTimeout } from "../../http.js";
import { createRateLimiter } from "../../rate-limit.js";
import type { ChannelSearchContext, SearchResultItem, WebSearchParams } from "../../types.js";
import { parseLocale } from "../bcp47.js";
import { recencyToExa } from "../recency.js";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_RESULTS = 5;

// Exa MCP (keyless) is rate-limited to 3 qps / 150 calls per day (researched).
const mcpLimiter = createRateLimiter(3);

export function exaApiKey(): string | null {
	const key = process.env.EXA_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}

/** Whether this channel can honor the request as-is. Keyless MCP only
 *  exposes query + numResults — filtered/localized requests need the keyed
 *  REST surface, so keyless skips them instead of silently dropping filters. */
export function exaSupports(params: WebSearchParams): boolean {
	if (exaApiKey()) return true;
	return !params.allowed_domains?.length && !params.blocked_domains?.length && !params.recency && !params.locale;
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code?: number; message?: string };
}

export async function searchWithExa(params: WebSearchParams, ctx: ChannelSearchContext): Promise<SearchResultItem[]> {
	const key = exaApiKey();
	if (!key) {
		if (!exaSupports(params)) {
			throw new Error("internal error: keyless Exa cannot honor filtered queries");
		}
		return searchExaMcp(params, ctx);
	}
	return searchExaSdk(params, key);
}

// ── key mode: official SDK (exa-js) ─────────────────────────────

async function searchExaSdk(params: WebSearchParams, apiKey: string): Promise<SearchResultItem[]> {
	const exa = new Exa(apiKey);
	const { country } = parseLocale(params.locale);
	const response = await exa.search(params.query, {
		type: "auto",
		numResults: DEFAULT_RESULTS,
		...(params.allowed_domains?.length ? { includeDomains: params.allowed_domains } : {}),
		...(params.blocked_domains?.length ? { excludeDomains: params.blocked_domains } : {}),
		...(params.recency ? { startPublishedDate: recencyToExa(params.recency) } : {}),
		...(country ? { userLocation: country } : {}),
		contents: { highlights: true },
	});

	const results: SearchResultItem[] = (response.results ?? [])
		.filter((r) => r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.highlights ?? []).join("\n"),
			...(r.publishedDate ? { pageAge: isoToRelativeAge(r.publishedDate) } : {}),
			...(r.author ? { author: r.author } : {}),
		}));
	return results;
}

// ── keyless mode: MCP (SSE) — no official SDK for this path ─────

async function searchExaMcp(params: WebSearchParams, ctx: ChannelSearchContext): Promise<SearchResultItem[]> {
	return mcpLimiter.run(() => searchExaMcpInner(params, ctx));
}

async function searchExaMcpInner(params: WebSearchParams, ctx: ChannelSearchContext): Promise<SearchResultItem[]> {
	const response = await fetchWithTimeout(
		EXA_MCP_URL,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: {
						// MCP web_search_exa exposes only query + numResults (researched).
						query: params.query,
						numResults: DEFAULT_RESULTS,
					},
				},
			}),
		},
		{ signal: ctx.signal, timeoutMs: ctx.timeoutMs },
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Exa MCP error ${response.status}: ${text.slice(0, 300)}`);
	}

	// MCP streams the result as SSE (event: message / data: {jsonrpc…}).
	const body = await response.text();
	const parsed = parseMcpResponse(body);
	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		throw new Error(`Exa MCP error${code}: ${parsed.error.message || "Unknown error"}`);
	}
	if (parsed.result?.isError) {
		const message =
			parsed.result.content
				?.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text)
				.join("\n") || "Exa MCP tool error";
		throw new Error(`Exa MCP error: ${message.slice(0, 300)}`);
	}

	const content = parsed.result?.content ?? [];
	const text = content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n\n");
	const results = parseMcpResults(text);
	return results;
}

/** Parse the MCP SSE body (data: lines) into a JSON-RPC response. */
function parseMcpResponse(body: string): ExaMcpRpcResponse {
	const dataLines = body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean);

	for (const payload of dataLines) {
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) return candidate;
		} catch {
			// skip malformed lines
		}
	}
	try {
		const candidate = JSON.parse(body) as ExaMcpRpcResponse;
		if (candidate?.result || candidate?.error) return candidate;
	} catch {
		// not plain JSON
	}
	throw new Error("Exa MCP returned an empty response");
}

/** Parse Exa MCP web_search_exa text output.
 *
 * Format is plain text per result:
 *   Title: …
 *   URL: …
 *   Published: …
 *   Author: …
 *   Highlights:
 *   …
 * (older JSON lines may also appear — both are handled).
 */
function parseMcpResults(text: string): SearchResultItem[] {
	const items: SearchResultItem[] = [];

	// JSON-lines form first.
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const obj = JSON.parse(trimmed) as {
				title?: string;
				url?: string;
				text?: string;
				publishedDate?: string;
				author?: string;
			};
			if (obj.url) {
				items.push({
					title: obj.title || "",
					url: obj.url,
					snippet: obj.text || "",
					...(obj.publishedDate ? { pageAge: isoToRelativeAge(obj.publishedDate) } : {}),
					...(obj.author ? { author: obj.author } : {}),
				});
			}
		} catch {
			// skip malformed lines
		}
	}
	if (items.length > 0) return items;

	// Plain text form: consecutive blocks of Title:/URL:/… separated by blanks.
	const blocks = text.split(/\n\s*\n/);
	for (const block of blocks) {
		const title = block.match(/Title:\s*(.+)/)?.[1]?.trim();
		const url = block.match(/URL:\s*(\S+)/)?.[1]?.trim();
		if (!url || !title) continue;
		const highlight = block.match(/Highlights:\s*\n([\s\S]*)/)?.[1]?.trim();
		const published = block.match(/Published:\s*(\S+)/)?.[1]?.trim();
		const author = block.match(/Author:\s*(.+)/)?.[1]?.trim();
		items.push({
			title,
			url,
			snippet: highlight ?? "",
			...(published && published !== "N/A" ? { pageAge: isoToRelativeAge(published) } : {}),
			...(author && author !== "N/A" ? { author } : {}),
		});
	}
	return items;
}
