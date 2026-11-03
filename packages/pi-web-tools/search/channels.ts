/**
 * pi-web-tools — channel registry (SPEC 通道架构).
 *
 * The fuse, in order — one self-describing channel object per adapter:
 * environment gate (key presence), capability gate, the search call, and the
 * card echo. Adding a channel = one adapter file + one entry here. The walk
 * itself (failover, failure capture, the no-candidate case) lives in
 * search/fuse.ts. TinyFish first (unlimited free tier), Firecrawl last (its
 * keyed pool is shared with pi-read-doc's OCR credits).
 */

import type { SearchChannel } from "../types.js";
import { exaSupports, searchWithExa } from "./api/exa.js";
import { searchWithFirecrawl } from "./api/firecrawl.js";
import { isTavilyAvailable, searchWithTavily } from "./api/tavily.js";
import { searchWithTinyfish, tinyfishApiKey } from "./api/tinyfish.js";

/** The fuse, in order. */
export const CHANNELS: SearchChannel[] = [
	{
		id: "tinyfish",
		available: () => !!tinyfishApiKey(),
		supports: () => true,
		search: searchWithTinyfish,
	},
	{
		id: "exa",
		available: () => true, // MCP mode works without a key
		supports: exaSupports,
		search: searchWithExa,
	},
	{
		id: "tavily",
		available: () => isTavilyAvailable(),
		supports: () => true,
		search: searchWithTavily,
	},
	{
		id: "firecrawl",
		available: () => true, // keyless mode works without a key
		supports: () => true,
		search: searchWithFirecrawl,
	},
];
