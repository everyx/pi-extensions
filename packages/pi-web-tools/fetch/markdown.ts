/**
 * pi-web-tools — HTML → Markdown (SPEC: web_fetch 行为规格).
 *
 * Mature-library pipeline (researched): linkedom (DOM) →
 * @mozilla/readability (article extraction, strips nav/ads/footers) →
 * turndown (HTML → Markdown).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

export interface ExtractResult {
	title: string;
	markdown: string;
	/** Set when extraction produced nothing readable. */
	error?: string;
}

/** Minimum markdown length below which we consider extraction a failure. */
export const MIN_USEFUL_CONTENT = 40;

/** Heuristic: page likely needs JS to render content (SPA). */
export function isLikelyJSRendered(html: string): boolean {
	const head = html.slice(0, 20_000).toLowerCase();
	const bodyHasContent = /<(p|article|h1|h2|h3|pre|table|ul|ol)\b/i.test(html);
	return (
		!bodyHasContent &&
		(head.includes("__next") ||
			head.includes("nuxt") ||
			head.includes("react") ||
			head.includes('id="app"') ||
			head.includes("id='app'"))
	);
}

/** Convert HTML to readable markdown (article extraction + turndown). */
export function htmlToMarkdown(html: string): ExtractResult {
	const { document } = parseHTML(html);
	// linkedom's document is not a DOM Document; Readability only needs the
	// methods it actually calls, so the cast is safe (same pattern as pi-web).
	const reader = new Readability(document as never);
	const article = reader.parse();

	if (!article?.content) {
		return { title: "", markdown: "", error: "Could not extract readable content" };
	}

	const markdown = turndown.turndown(article.content).trim();
	if (markdown.length < MIN_USEFUL_CONTENT) {
		return {
			title: article.title || "",
			markdown,
			error: isLikelyJSRendered(html)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Extracted content appears incomplete",
		};
	}

	return { title: article.title || "", markdown };
}
