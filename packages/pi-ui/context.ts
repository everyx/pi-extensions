/**
 * LLM context protection — the shared stash primitive.
 *
 * One semantic across every tool: the LLM sees a capped preview, and when
 * content was cut the full text is stashed in /tmp so it's one `read` away.
 * Budget is pi-bash parity (2000 lines / 50KB, whichever hits first) via
 * pi's own truncateHead/truncateTail.
 *
 * This lives in pi-ui as a shared extension primitive (not TUI-specific);
 * both pi-subagent and pi-web-tools consume it.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

interface ContextStash {
	/** Capped preview text (LLM-visible). */
	text: string;
	/** Full-text path when truncated; undefined when the text fit. */
	stashPath?: string;
}

/** Inline marker for a stash path — callers append it to LLM-visible text. */
export function truncationMarker(stashPath: string): string {
	return `\n\n(output truncated — full output: ${stashPath})`;
}

/**
 * Cap `fullText` to the context budget; on truncation write the full text
 * to /tmp and return its path. Same key → same filename, so re-stashes are
 * idempotent overwrites. Write failures are best-effort: the caller still
 * gets the capped preview.
 *
 * @param key stable identifier hashed into the filename (agent id, url…)
 * @param opts.keep "head" keeps the beginning (documents), "tail" keeps the
 *   latest (activity output, pi-bash style). Default "head".
 */
export function stashOverflow(fullText: string, key: string, opts?: { keep?: "head" | "tail" }): ContextStash {
	const result = opts?.keep === "tail" ? truncateTail(fullText) : truncateHead(fullText);
	if (!result.truncated) return { text: result.content };
	const file = `/tmp/pi-stash-${createHash("sha1").update(key).digest("hex").slice(0, 8)}.txt`;
	try {
		writeFileSync(file, fullText, "utf8");
		return { text: result.content, stashPath: file };
	} catch {
		return { text: result.content }; // best-effort: never break the caller
	}
}
