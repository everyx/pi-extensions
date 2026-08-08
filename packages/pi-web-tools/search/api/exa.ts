/**
 * pi-web-tools — Exa channel.
 *
 * Dual mode (SPEC: Exa MCP 零配置 + API key 双模):
 *   - no EXA_API_KEY  → MCP endpoint (mcp.exa.ai, JSON-RPC web_search_exa).
 *     The official exa-js SDK requires an API key, so this mode stays on a
 *     hand-rolled MCP call (SSE response).
 *   - with key        → official SDK (exa-js).
 */

import Exa from "exa-js";
import { fetchWithTimeout } from "../../http.ts";
import type { ChannelSearchContext, ChannelSearchResult, SearchResultItem, WebSearchParams } from "../../types.ts";
import { recencyToExa } from "../recency.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_RESULTS = 5;

export function exaApiKey(): string | null {
	const key = process.env.EXA_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}

export function isExaAvailable(): boolean {
	return true; // MCP mode works without a key
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code?: number; message?: string };
}

export async function searchWithExa(params: WebSearchParams, ctx: ChannelSearchContext): Promise<ChannelSearchResult> {
	const key = exaApiKey();
	return key ? searchExaSdk(params, key) : searchExaMcp(params, ctx);
}

// ── key mode: official SDK (exa-js) ─────────────────────────────

async function searchExaSdk(params: WebSearchParams, apiKey: string): Promise<ChannelSearchResult> {
	const exa = new Exa(apiKey);
	const response = await exa.search(params.query, {
		type: "auto",
		numResults: DEFAULT_RESULTS,
		...(params.allowed_domains?.length ? { includeDomains: params.allowed_domains } : {}),
		...(params.blocked_domains?.length ? { excludeDomains: params.blocked_domains } : {}),
		...(params.recency ? { startPublishedDate: recencyToExa(params.recency) } : {}),
		contents: { highlights: true },
	});

	const results: SearchResultItem[] = (response.results ?? [])
		.filter((r) => r?.url)
		.map((r) => ({
			title: r.title || "",
			url: r.url,
			snippet: (r.highlights?.[0] ?? "").slice(0, 300),
		}));
	return { results, total: results.length };
}

// ── keyless mode: MCP (SSE) — no official SDK for this path ─────

/** Normalize domains for Exa (includeDomains / excludeDomains). */
function domainArgs(params: WebSearchParams): Record<string, unknown> {
	const include = params.allowed_domains ?? [];
	const exclude = params.blocked_domains ?? [];
	return {
		...(include.length ? { includeDomains: include } : {}),
		...(exclude.length ? { excludeDomains: exclude } : {}),
	};
}

async function searchExaMcp(params: WebSearchParams, ctx: ChannelSearchContext): Promise<ChannelSearchResult> {
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
						query: params.query,
						numResults: DEFAULT_RESULTS,
						type: "auto",
						...domainArgs(params),
						...(params.recency ? { startPublishedDate: recencyToExa(params.recency) } : {}),
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
	return { results, total: results.length };
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
			const obj = JSON.parse(trimmed) as { title?: string; url?: string; text?: string };
			if (obj.url) {
				items.push({
					title: obj.title || "",
					url: obj.url,
					snippet: (obj.text || "").slice(0, 300),
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
		items.push({
			title,
			url,
			snippet: (highlight ?? "").slice(0, 300),
		});
	}
	return items;
}
