/**
 * pi-web-tools — channel registry (SPEC 通道架构).
 *
 * One ordered list, availability by environment (key presence / bsk CLI),
 * capability gate per channel-mode. The router walks the order and fails
 * over on error; the last entry (bsk) is the no-key fuse, not an equal
 * peer. TinyFish first (unlimited free tier), Firecrawl last among APIs
 * (its keyed pool is shared with pi-read-doc's OCR credits).
 */

import type { ChannelId, WebSearchParams } from "../types.js";
import { exaSupports } from "./api/exa.js";
import { isTavilyAvailable } from "./api/tavily.js";
import { tinyfishApiKey } from "./api/tinyfish.js";
import { isBskAvailable } from "./browser.js";

export const CHANNEL_ORDER = ["tinyfish", "exa", "tavily", "firecrawl", "bsk"] as const satisfies readonly ChannelId[];

interface ChannelDef {
	/** Environment gate — an unavailable channel is not a candidate. */
	available: () => boolean | Promise<boolean>;
	/** Capability gate — an available channel that cannot honor this
	 *  request's filters is skipped (SPEC: 能力缺失不静默，跳过而非降级).
	 *  Dispatch itself lives in index.ts runChannel (needs the AbortSignal
	 *  from the tool call). */
	supports: (params: WebSearchParams) => boolean;
}

const CHANNELS: Record<ChannelId, ChannelDef> = {
	tinyfish: {
		available: () => !!tinyfishApiKey(),
		supports: () => true,
	},
	exa: {
		available: () => true, // MCP mode works without a key
		supports: exaSupports,
	},
	tavily: {
		available: () => isTavilyAvailable(),
		supports: () => true,
	},
	firecrawl: {
		available: () => true, // keyless mode works without a key
		supports: () => true,
	},
	bsk: {
		available: () => isBskAvailable(),
		supports: () => true, // domain filters compile to native site: operators
	},
};

/** Channels that are available AND can honor this exact request, in fuse
 *  order (async: bsk probes the CLI on first use; the probe result is
 *  cached inside its adapter). */
export async function candidatesFor(params: WebSearchParams): Promise<ChannelId[]> {
	const out: ChannelId[] = [];
	for (const id of CHANNEL_ORDER) {
		if ((await CHANNELS[id].available()) && CHANNELS[id].supports(params)) out.push(id);
	}
	return out;
}
