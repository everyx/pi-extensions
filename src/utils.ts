/**
 * pi-subagent — shared utilities.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ContentPart = { type: string; text?: string };

/**
 * Extract the last assistant message text from the session branch.
 */
export function lastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			const parts = (e.message.content ?? [])
				.filter((c: ContentPart) => c.type === "text")
				.map((c: ContentPart) => c.text);
			const text = parts.join("\n").trim();
			if (text) return text;
		}
	}
	return "";
}
