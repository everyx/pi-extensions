/**
 * pi-web-tools — grounding channel (SPEC: 模型 grounding).
 *
 * Reuses the *current* pi model endpoint (方案 A): the provider/baseUrl of
 * the model in use decides whether grounding is available — grounding lives
 * on the API endpoint, not the model (OpenAI/Anthropic/Gemini/DeepSeek/
 * OpenRouter official endpoints support it; relays like OpenCode Zen do not).
 *
 * Official SDKs where they exist: openai (Responses web_search),
 * @anthropic-ai/sdk (web_search tool, also serves DeepSeek via baseURL),
 * @google/genai (googleSearch). OpenRouter's server-side web_search plugin
 * has no SDK adaptation — hand-rolled chat/completions call.
 *
 * Returns are model-generated answers + citations, mapped onto the
 * { results, total } shape (answer → snippet fallback, citations → results).
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { fetchWithTimeout } from "../http.ts";
import type { ChannelSearchContext, ChannelSearchResult, SearchResultItem, WebSearchParams } from "../types.ts";

/** Endpoints that host a grounding/search capability (SPEC research). */
export type GroundingKind = "openai" | "anthropic" | "gemini" | "deepseek" | "openrouter";

export interface GroundingEndpoint {
	kind: GroundingKind;
	baseUrl: string;
	model: string;
}

/** Map a pi Model (provider + baseUrl) to a grounding endpoint kind, or null. */
export function groundingEndpointFor(provider: string, baseUrl: string, model: string): GroundingEndpoint | null {
	const p = provider.toLowerCase();
	const b = baseUrl.toLowerCase();
	if (p.includes("deepseek") || b.includes("deepseek.com")) {
		return { kind: "deepseek", baseUrl: b, model };
	}
	if (p.includes("openrouter") || b.includes("openrouter.ai")) {
		return { kind: "openrouter", baseUrl: b, model };
	}
	if (p.includes("gemini") || p.includes("google") || b.includes("googleapis")) {
		return { kind: "gemini", baseUrl: b, model };
	}
	if (p.includes("anthropic") || b.includes("anthropic.com")) {
		return { kind: "anthropic", baseUrl: b, model };
	}
	if (p.includes("openai") || b.includes("openai.com") || b.includes("azure.com")) {
		return { kind: "openai", baseUrl: b, model };
	}
	return null;
}

/** Pure capability check: does the current model endpoint support grounding? */
export function isGroundingAvailable(provider: string, baseUrl: string, model: string): boolean {
	return groundingEndpointFor(provider, baseUrl, model) !== null;
}

export async function searchWithGrounding(
	params: WebSearchParams,
	endpoint: GroundingEndpoint,
	apiKey: string,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	switch (endpoint.kind) {
		case "openai":
			return searchOpenAi(params, endpoint, apiKey);
		case "anthropic":
		case "deepseek":
			return searchAnthropicStyle(params, endpoint, apiKey);
		case "gemini":
			return searchGemini(params, endpoint, apiKey);
		case "openrouter":
			return searchOpenRouter(params, endpoint, apiKey, ctx);
	}
}

// ── OpenAI (official SDK, Responses API web_search) ─────────────

interface WebSearchResultItem {
	url: string;
	title?: string;
}

async function searchOpenAi(
	params: WebSearchParams,
	endpoint: GroundingEndpoint,
	apiKey: string,
): Promise<ChannelSearchResult> {
	const client = new OpenAI({ apiKey, baseURL: endpoint.baseUrl });
	const response = await client.responses.create({
		model: endpoint.model,
		input: [{ role: "user", content: params.query }],
		tools: [{ type: "web_search" }],
		include: ["web_search_call.action.sources", "web_search_call.results"],
	});

	// SDK types model web_search_call.action.sources as url-only; the richer
	// per-call `results` (title/text) come with include: web_search_call.results
	// but are not surfaced in the types — read them via a loose cast.
	const items: WebSearchResultItem[] = [];
	for (const call of response.output ?? []) {
		if (call.type !== "web_search_call") continue;
		const action = call.action as { type: string; sources?: Array<{ url?: string; title?: string }> };
		for (const s of action.sources ?? []) {
			if (s.url) items.push({ url: s.url, title: s.title });
		}
		const results = (call as unknown as { results?: Array<{ url?: string; title?: string }> }).results ?? [];
		for (const r of results) {
			if (r.url) items.push({ url: r.url, title: r.title });
		}
	}

	const seen = new Set<string>();
	const results: SearchResultItem[] = items
		.filter((i) => {
			if (seen.has(i.url)) return false;
			seen.add(i.url);
			return true;
		})
		.map((i) => ({ title: i.title ?? "", url: i.url, snippet: "" }));
	return { results, total: results.length };
}

// ── Anthropic / DeepSeek (official @anthropic-ai/sdk) ───────────

async function searchAnthropicStyle(
	params: WebSearchParams,
	endpoint: GroundingEndpoint,
	apiKey: string,
): Promise<ChannelSearchResult> {
	// DeepSeek serves grounding via its Anthropic-compatible endpoint.
	const client = new Anthropic({
		apiKey,
		...(endpoint.kind === "deepseek" ? { baseURL: endpoint.baseUrl } : {}),
	});

	const response = await client.messages.create({
		model: endpoint.model,
		max_tokens: 1024,
		messages: [{ role: "user", content: params.query }],
		tools: [
			{
				name: "web_search",
				type: "web_search_20250305",
				...(params.allowed_domains?.length ? { allowed_domains: params.allowed_domains } : {}),
			},
		],
	});

	// Web search citations live on text blocks (type "web_search_result_location").
	const citations = (response.content ?? [])
		.filter((b) => b.type === "text")
		.flatMap((b) => b.citations ?? [])
		.filter(
			(c): c is Extract<Anthropic.TextCitation, { type: "web_search_result_location" }> =>
				c.type === "web_search_result_location",
		);
	const results: SearchResultItem[] = citations
		.filter((c) => c.url)
		.map((c) => ({ title: c.title ?? "", url: c.url, snippet: c.cited_text }));
	return { results, total: results.length };
}

// ── Gemini (official @google/genai SDK) ─────────────────────────

async function searchGemini(
	params: WebSearchParams,
	endpoint: GroundingEndpoint,
	apiKey: string,
): Promise<ChannelSearchResult> {
	const client = new GoogleGenAI({ apiKey });
	const response = await client.models.generateContent({
		model: endpoint.model,
		contents: [{ role: "user", parts: [{ text: params.query }] }],
		config: { tools: [{ googleSearch: {} }] },
	});

	const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
	const results: SearchResultItem[] = chunks
		.filter((c) => c.web?.uri)
		.map((c) => ({ title: c.web?.title ?? "", url: c.web?.uri ?? "", snippet: "" }));
	return { results, total: results.length };
}

// ── OpenRouter (no SDK adaptation for server-side web_search) ───

interface OpenRouterSource {
	url?: string;
	title?: string;
}

async function searchOpenRouter(
	params: WebSearchParams,
	endpoint: GroundingEndpoint,
	apiKey: string,
	ctx: ChannelSearchContext,
): Promise<ChannelSearchResult> {
	const base = endpoint.baseUrl.replace(/\/$/, "");
	const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
	const response = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: endpoint.model,
				messages: [{ role: "user", content: params.query }],
				plugins: [{ id: "web_search", max_num_results: 5 }],
			}),
		},
		{ signal: ctx.signal, timeoutMs: ctx.timeoutMs },
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenRouter grounding error ${response.status}: ${text.slice(0, 300)}`);
	}
	const data = (await response.json()) as {
		choices?: Array<{ message?: { web_search_links?: OpenRouterSource[]; citations?: OpenRouterSource[] } }>;
	};
	const msg = data.choices?.[0]?.message;
	const sources = msg?.web_search_links ?? msg?.citations ?? [];
	const results: SearchResultItem[] = sources
		.filter((s) => s.url)
		.map((s) => ({ title: s.title ?? "", url: s.url ?? "", snippet: "" }));
	return { results, total: results.length };
}
