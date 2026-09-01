/**
 * pi-web-tools — the search fuse walk (SPEC 通道架构).
 *
 * The package's core concept: walk the ordered channels, fail over on
 * error, keep the LLM on results-or-terse-error while channel diagnostics
 * stay in details (错误分层). Pure composition — the HTTP/CLI lives in the
 * channel adapters, so tests drive the walk with fake channels (no keys,
 * no network).
 */

import type {
	ChannelId,
	ChannelSearchContext,
	EngineId,
	SearchChannel,
	SearchResultItem,
	WebSearchParams,
} from "../types.js";

/** One failed channel attempt (in fuse order). */
export interface SearchFuseFailure {
	channel: string;
	error: string;
	/** Config guidance (UI-visible only — never in the LLM text). */
	hint?: string;
}

/** The walk's outcome: a win (channel + results + echo) or the failure list. */
export interface SearchFuseOutcome {
	/** The channel that answered (undefined when none did). */
	channel?: ChannelId;
	/** Card echo from the answering channel (e.g. the bsk engine). */
	echo?: { engine: EngineId };
	results: SearchResultItem[];
	/** Every failed attempt, in fuse order. */
	failures: SearchFuseFailure[];
	/** The LLM-visible error when all candidates failed: the last channel's
	 *  raw error (the aggregate "All channels failed: …" goes to details). */
	lastError?: string;
}

/** Channels that are available AND can honor this exact request, in fuse
 *  order (async: bsk probes the CLI on first use; the probe result is
 *  cached inside its adapter). */
export async function candidatesFor(params: WebSearchParams, channels: SearchChannel[]): Promise<SearchChannel[]> {
	const out: SearchChannel[] = [];
	for (const c of channels) {
		if ((await c.available()) && c.supports(params)) out.push(c);
	}
	return out;
}

/** Walk the fuse: try each candidate in order until one answers.
 *  `onAttempt` fires before each channel (the caller surfaces the live card
 *  state — the fuse itself has no UI). */
export async function searchFuse(
	params: WebSearchParams,
	channels: SearchChannel[],
	ctx: ChannelSearchContext & { onAttempt?: (channel: ChannelId) => void },
): Promise<SearchFuseOutcome> {
	const failures: SearchFuseFailure[] = [];
	for (const c of await candidatesFor(params, channels)) {
		ctx.onAttempt?.(c.id);
		try {
			const results = await c.search(params, { signal: ctx.signal });
			return { channel: c.id, echo: c.echo?.(params), results, failures };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			// Config guidance travels in details (UI), never in LLM text
			// (SPEC 错误分层: LLM 不含安装/配置指引).
			const maybeHint = (err as { hint?: unknown }).hint;
			failures.push({ channel: c.id, error, ...(typeof maybeHint === "string" ? { hint: maybeHint } : {}) });
		}
	}
	return { results: [], failures, lastError: failures[failures.length - 1]?.error };
}
