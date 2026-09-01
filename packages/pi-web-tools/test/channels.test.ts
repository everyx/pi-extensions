/**
 * Tests for the channel registry (search/channels.ts): fuse order, key
 * availability, and the keyless-Exa capability gate. The walk itself is
 * tested with fake channels in fuse.test.ts; adapter HTTP behavior lives in
 * the per-adapter test files.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANNELS } from "../search/channels.js";
import { candidatesFor } from "../search/fuse.js";
import type { SearchChannel, WebSearchParams } from "../types.js";

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

const ids = (cs: SearchChannel[]) => cs.map((c) => c.id);

const bare: WebSearchParams = { query: "hello" };

describe("channel registry", () => {
	it("fuse order is api providers first, bsk last", () => {
		assert.deepEqual(
			CHANNELS.map((c) => c.id),
			["tinyfish", "exa", "tavily", "firecrawl", "bsk"],
		);
	});

	it("firecrawl and exa are always available (keyless modes)", async () => {
		await withEnv({ TINYFISH_API_KEY: undefined, EXA_API_KEY: undefined, TAVILY_API_KEY: undefined }, async () => {
			const candidates = ids(await candidatesFor(bare, CHANNELS));
			// bsk only joins when the CLI is installed — the CI/container case.
			assert.deepEqual(
				candidates.filter((c) => c !== "bsk"),
				["exa", "firecrawl"],
			);
		});
	});

	it("keys unlock tinyfish and tavily in fuse order", async () => {
		await withEnv({ TINYFISH_API_KEY: "k", EXA_API_KEY: undefined, TAVILY_API_KEY: "k" }, async () => {
			const candidates = ids(await candidatesFor(bare, CHANNELS));
			assert.deepEqual(
				candidates.filter((c) => c !== "bsk"),
				["tinyfish", "exa", "tavily", "firecrawl"],
			);
		});
	});

	it("keyless exa skips filtered queries instead of dropping filters", async () => {
		await withEnv({ EXA_API_KEY: undefined }, async () => {
			const filtered: WebSearchParams = { query: "q", blocked_domains: ["reddit.com"] };
			const candidates = ids(await candidatesFor(filtered, CHANNELS));
			assert.ok(!candidates.includes("exa"), "keyless exa must skip filtered queries");
			// keyed exa honors everything
			await withEnv({ EXA_API_KEY: "k" }, async () => {
				assert.ok(ids(await candidatesFor(filtered, CHANNELS)).includes("exa"));
			});
		});
	});

	it("keyless exa serves bare queries (query + numResults is enough)", async () => {
		await withEnv({ EXA_API_KEY: undefined }, async () => {
			assert.ok(ids(await candidatesFor(bare, CHANNELS)).includes("exa"));
		});
	});
});
