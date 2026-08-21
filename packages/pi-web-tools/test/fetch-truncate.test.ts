import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capContent, webFetch } from "../fetch/fetch.js";

describe("capContent — byte-budget truncation (pi truncateHead parity)", () => {
	it("passes short text through unchanged", () => {
		const text = "# Title\n\nshort body";
		assert.equal(capContent(text), text);
	});

	it("caps ASCII content at 50KB of bytes, keeping the head", () => {
		const text = `# Doc\n\n${"x".repeat(100_000)}`;
		const out = capContent(text);
		assert.ok(Buffer.byteLength(out, "utf8") <= 50_000, `bytes ${Buffer.byteLength(out, "utf8")} > 50KB`);
		assert.ok(out.startsWith("# Doc"), "head must be kept");
	});

	it("caps CJK content at the same byte budget (not char count)", () => {
		// 50k CJK chars = ~150KB bytes — char slicing would blow the budget 3x.
		const text = `# 文档\n\n${"调研亮色高亮色处理方案".repeat(20_000)}`;
		const out = capContent(text);
		assert.ok(Buffer.byteLength(out, "utf8") <= 50_000, `bytes ${Buffer.byteLength(out, "utf8")} > 50KB`);
		assert.ok(out.startsWith("# 文档"), "head must be kept");
	});
});

describe("fetch connection-error diagnostics", () => {
	it("webFetch surfaces the undici cause code (ECONNRESET) for server resets", async () => {
		// Blackhole IP (RFC 5737) — connection attempt fails fast, undici reports
		// cause.code instead of a bare "fetch failed".
		const r = await webFetch("https://192.0.2.1/");
		assert.ok(r.error, "expected an error");
		assert.ok(r.error.includes("fetch failed"), `got: ${r.error}`);
		assert.ok(
			/\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|UND_ERR)/.test(r.error),
			`cause code missing: ${r.error}`,
		);
	});
});

describe("webFetch raw option", () => {
	// example.com is an ICANN-reserved test domain — stable, always returns a
	// small fixed HTML page, so raw vs default behaviour is deterministic.
	it("raw: true returns the HTML source in an html code fence", async () => {
		const r = await webFetch("https://example.com/", { raw: true });
		assert.ok(r.content.includes("```html"), "raw HTML wrapped in an html code fence");
		assert.ok(r.content.includes("<html"), "raw HTML source returned, not converted");
		assert.ok(r.content.includes("Example Domain"));
	});

	it("default converts HTML to markdown without a fence", async () => {
		const r = await webFetch("https://example.com/");
		assert.ok(r.content.includes("Example Domain"), "markdown body has the title");
		assert.ok(!r.content.includes("```html"), "converted markdown is prose, not fenced");
		assert.ok(!r.content.includes("<html>"), "no raw HTML tags in converted output");
	});

	it("error path leaves content empty", async () => {
		const r = await webFetch("not-a-url");
		assert.equal(r.content, "");
		assert.match(r.error ?? "", /Unsupported URL/);
	});
});
