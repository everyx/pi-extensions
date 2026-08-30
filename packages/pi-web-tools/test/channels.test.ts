/**
 * Tests for the channel registry (search/channels.ts): fuse order, key
 * availability, and the keyless-Exa capability gate. Adapter HTTP behavior
 * lives in the per-adapter test files.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANNEL_ORDER, candidatesFor } from "../search/channels.js";
import type { WebSearchParams } from "../types.js";

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

const bare: WebSearchParams = { query: "hello" };

describe("channel registry", () => {
	it("fuse order is api providers first, bsk last", () => {
		assert.deepEqual(CHANNEL_ORDER, ["tinyfish", "exa", "tavily", "firecrawl", "bsk"]);
	});

	it("firecrawl and exa are always available (keyless modes)", async () => {
		await withEnv({ TINYFISH_API_KEY: undefined, EXA_API_KEY: undefined, TAVILY_API_KEY: undefined }, async () => {
			const candidates = await candidatesFor(bare);
			// bsk only joins when the CLI is installed — the CI/container case.
			assert.deepEqual(
				candidates.filter((c) => c !== "bsk"),
				["exa", "firecrawl"],
			);
		});
	});

	it("keys unlock tinyfish and tavily in fuse order", async () => {
		await withEnv({ TINYFISH_API_KEY: "k", EXA_API_KEY: undefined, TAVILY_API_KEY: "k" }, async () => {
			const candidates = await candidatesFor(bare);
			assert.deepEqual(
				candidates.filter((c) => c !== "bsk"),
				["tinyfish", "exa", "tavily", "firecrawl"],
			);
		});
	});

	it("keyless exa skips filtered queries instead of dropping filters", async () => {
		await withEnv({ EXA_API_KEY: undefined }, async () => {
			const filtered: WebSearchParams = { query: "q", blocked_domains: ["reddit.com"] };
			const candidates = await candidatesFor(filtered);
			assert.ok(!candidates.includes("exa"), "keyless exa must skip filtered queries");
			// keyed exa honors everything
			await withEnv({ EXA_API_KEY: "k" }, async () => {
				assert.ok((await candidatesFor(filtered)).includes("exa"));
			});
		});
	});

	it("keyless exa serves bare queries (query + numResults is enough)", async () => {
		await withEnv({ EXA_API_KEY: undefined }, async () => {
			assert.ok((await candidatesFor(bare)).includes("exa"));
		});
	});
});
