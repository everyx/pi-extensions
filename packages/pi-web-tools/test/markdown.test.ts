/**
 * Tests for HTML → Markdown extraction (fetch/markdown.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToMarkdown, isLikelyJSRendered } from "../fetch/markdown.js";

describe("htmlToMarkdown", () => {
	it("extracts the article body as markdown with the title", () => {
		const html = `
			<html><head><title>Example Page</title></head>
			<body>
				<nav><a href="/">Home</a></nav>
				<article>
					<h1>Hello World</h1>
					<p>This is the <a href="https://example.com/link">main content</a>.</p>
					<ul><li>Item one</li><li>Item two</li></ul>
				</article>
				<footer>© 2026</footer>
			</body></html>`;
		const result = htmlToMarkdown(html);
		assert.equal(result.error, undefined);
		assert.ok(result.title.length > 0);
		assert.match(result.markdown, /Hello World/);
		assert.match(result.markdown, /main content/);
		assert.match(result.markdown, /Item one/);
		// Nav/footer stripped by Readability.
		assert.ok(!result.markdown.includes("Home"));
		assert.ok(!result.markdown.includes("© 2026"));
	});
	it("emits Markdown-for-Agents layout: frontmatter → body → JSON-LD", () => {
		const html = `<html><head>
<title>Example Page</title>
<meta name="description" content="A test page description that is long enough">
<meta property="og:image" content="https://example.com/cover.png">
<script type="application/ld+json">{"@type":"Article","headline":"T"}</script>
</head><body><article><h1>Hello World</h1><p>This is the main content of the page and it is definitely long enough to pass the minimum useful content threshold check.</p></article></body></html>`;
		const result = htmlToMarkdown(html);
		assert.equal(result.title, "Example Page");
		assert.match(
			result.markdown,
			/^---\ntitle: Example Page\ndescription: A test page description that is long enough\nimage: https:\/\/example\.com\/cover\.png\n---\n\n/,
		);
		assert.match(result.markdown, /```json\n\{"@type":"Article".*\n```\n$/);
	});

	it("prefers meta title over the <title> tag (Cloudflare precedence)", () => {
		const html = `<html><head><title>Tag Title</title><meta property="og:title" content="OG Title">
</head><body><article><h1>Hello World</h1><p>This is the main content of the page and it is definitely long enough to pass the minimum useful content threshold check.</p></article></body></html>`;
		const result = htmlToMarkdown(html);
		assert.equal(result.title, "OG Title");
		assert.match(result.markdown, /^---\ntitle: OG Title\n/);
	});

	it("returns an error when content is unreadable or too short", () => {
		const result = htmlToMarkdown("<html><body><p>x</p></body></html>");
		assert.ok(result.error, "expected an error for near-empty content");
	});

	it("flags incomplete extraction when the body is nearly empty", () => {
		const result = htmlToMarkdown(
			"<html><head><title>T</title></head><body><article><p>tiny</p></article></body></html>",
		);
		assert.ok(result.error);
		assert.match(result.error, /incomplete/i);
	});
});

describe("isLikelyJSRendered", () => {
	it("detects SPA shells", () => {
		assert.equal(
			isLikelyJSRendered(
				'<html><head><script>window.__NEXT_DATA__ = {}</script></head><body><div id="app"></div></body></html>',
			),
			true,
		);
	});
	it("false for plain HTML with content", () => {
		assert.equal(isLikelyJSRendered("<html><body><article><p>real content here</p></article></body></html>"), false);
	});
	it("ignores HTML strings inside scripts (CSR bundles)", () => {
		const html = `<html><head><script>const t = "<h1>not real</h1><p>also not real</p>";</script></head><body><div id="root"></div></body></html>`;
		assert.equal(isLikelyJSRendered(html), true);
	});
	it("detects an empty root div shell as CSR", () => {
		assert.equal(
			isLikelyJSRendered('<html><head><title>T</title></head><body><div id="root"></div></body></html>'),
			true,
		);
	});
});
