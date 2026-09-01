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

interface ExtractResult {
	title: string;
	markdown: string;
	/** Set when extraction produced nothing readable. */
	error?: string;
}

/** Minimum markdown length below which we consider extraction a failure. */
const MIN_USEFUL_CONTENT = 40;

/** Heuristic: page likely needs JS to render content (SPA shell). */
export function isLikelyJSRendered(html: string): boolean {
	// Strip script/style blocks first — CSR bundles contain HTML strings that
	// would otherwise look like body content.
	const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const lower = html.toLowerCase();
	const bodyHasContent = /<(p|article|h1|h2|h3|pre|table|ul|ol)\b/i.test(markup);
	return (
		!bodyHasContent &&
		(lower.includes("__next") ||
			lower.includes("nuxt") ||
			lower.includes("react") ||
			/id=["'](app|root)["']/.test(lower))
	);
}

/** Convert HTML to readable markdown (article extraction + turndown).
 *
 * Output follows the Markdown for Agents layout (frontmatter → body → JSON-LD)
 * so the format is identical whether the markdown came from a Cloudflare
 * content-negotiated response or our local conversion.
 */
export function htmlToMarkdown(html: string): ExtractResult {
	const { document } = parseHTML(html);
	// Extract meta/JSON-LD before Readability runs — its parse pass strips
	// scripts and rewrites the document.
	const metaTitle = metaContent(document, ['meta[name="title"]', 'meta[property="og:title"]']);
	const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']);
	const image = metaContent(document, ['meta[property="og:image"]']);
	const jsonLd = extractJsonLd(document);

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

	// Title precedence mirrors Cloudflare (meta title > og:title), with the
	// <title> tag as a local fallback (Readability's own title can be swayed
	// by JSON-LD headline fields).
	const title = metaTitle || document.querySelector("title")?.textContent?.trim() || article.title || "";
	const fm = frontmatter(title, description, image);

	return { title, markdown: `${fm}${markdown}${jsonLd}` };
}

type LinkedomDocument = ReturnType<typeof parseHTML>["document"];

function metaContent(document: LinkedomDocument, selectors: string[]): string {
	for (const sel of selectors) {
		const value = document.querySelector(sel)?.getAttribute("content")?.trim();
		if (value) return value;
	}
	return "";
}

/** YAML frontmatter with only the fields that have values (Cloudflare layout). */
function frontmatter(title: string, description: string, image: string): string {
	const fields: string[] = [];
	if (title) fields.push(`title: ${title}`);
	if (description) fields.push(`description: ${description}`);
	if (image) fields.push(`image: ${image}`);
	if (!fields.length) return "";
	return `---\n${fields.join("\n")}\n---\n\n`;
}

/** JSON-LD blocks preserved as a fenced json block at the end (Cloudflare layout). */
function extractJsonLd(document: LinkedomDocument): string {
	const blocks: string[] = [];
	document.querySelectorAll('script[type="application/ld+json"]').forEach((el: { textContent: string | null }) => {
		const text = el.textContent?.trim();
		if (text) blocks.push(text);
	});
	if (!blocks.length) return "";
	return `\n\n\`\`\`json\n${blocks.join("\n")}\n\`\`\`\n`;
}
