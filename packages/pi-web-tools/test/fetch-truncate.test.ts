import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { stashOverflow } from "@everyx/pi-ui/context.js";
import { webFetch } from "../fetch/fetch.js";

describe("stashOverflow — context budget (pi truncateHead parity)", () => {
	it("passes short text through unchanged", () => {
		const text = "# Title\n\nshort body";
		assert.equal(stashOverflow(text, "k").text, text);
		assert.equal(stashOverflow(text, "k").stashPath, undefined);
	});

	it("caps ASCII content at 50KB of bytes, keeping the head", () => {
		const text = `# Doc\n\n${"x".repeat(100_000)}`;
		const r = stashOverflow(text, "k");
		assert.ok(Buffer.byteLength(r.text, "utf8") <= 51_200, `bytes ${Buffer.byteLength(r.text, "utf8")} > 50KiB`);
		assert.ok(r.text.startsWith("# Doc"), "head must be kept");
		assert.ok(r.stashPath?.startsWith("/tmp/pi-stash-"), "full text stashed");
	});

	it("caps CJK content at the same byte budget (not char count)", () => {
		// 50k CJK chars = ~150KB bytes — char slicing would blow the budget 3x.
		const text = `# 文档\n\n${"调研亮色高亮色处理方案".repeat(20_000)}`;
		const r = stashOverflow(text, "k");
		assert.ok(Buffer.byteLength(r.text, "utf8") <= 51_200, `bytes ${Buffer.byteLength(r.text, "utf8")} > 50KiB`);
		assert.ok(r.text.startsWith("# 文档"), "head must be kept");
		assert.ok(r.stashPath, "full text stashed even when only the line limit is far away");
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
	it("raw: true returns the HTML source verbatim — no fence, no decoration", async () => {
		const r = await webFetch("https://example.com/", { raw: true });
		assert.ok(!r.content.includes("```"), "content is never wrapped in a code fence");
		assert.ok(r.content.includes("<html"), "raw HTML source returned, not converted");
		assert.ok(r.content.includes("Example Domain"));
		assert.ok(r.contentType?.includes("text/html"), `contentType carried, got: ${r.contentType}`);
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

// Local server: deterministic offline coverage of the gate-free policy.
const listener = createServer((req, res) => {
	if (req.url === "/icon.svg") {
		res.writeHead(200, { "Content-Type": "image/svg+xml" });
		res.end('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
		return;
	}
	if (req.url === "/logo.png") {
		res.writeHead(200, { "Content-Type": "image/png" });
		res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
		return;
	}
	if (req.url === "/photo.png") {
		// 1×1 valid PNG — Photon can decode and pass it through.
		res.writeHead(200, { "Content-Type": "image/png" });
		res.end(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		return;
	}
	if (req.url === "/huge") {
		res.writeHead(200, { "Content-Type": "video/x-matroska" });
		res.end(Buffer.alloc(65 * 1024 * 1024, 0x41));
		return;
	}
	if (req.url === "/big.json") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `item-${i}` })) }));
		return;
	}
	if (req.url === "/big.html") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`<html><head><title>Big</title></head><body>${"<p>lorem ipsum</p>".repeat(6000)}</body></html>`);
		return;
	}
	res.writeHead(404);
	res.end();
});
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

describe("webFetch — no content-type gates", () => {
	it("an SVG passes through verbatim — it is text, whatever MIME says", async () => {
		const r = await webFetch(`${base}/icon.svg`);
		assert.ok(r.content.startsWith("<svg"), `svg source returned as-is, got: ${r.content.slice(0, 60)}`);
		assert.ok(r.contentType?.includes("image/svg+xml"));
		assert.equal(r.error, undefined);
	});

	it("a true binary still comes back — noisy but honest, never gated", async () => {
		const r = await webFetch(`${base}/logo.png`, { raw: true });
		assert.equal(r.error, undefined, `no policy rejection: ${r.error}`);
		assert.ok(r.contentType?.includes("image/png"));
		assert.ok(r.content.length > 0, "bytes delivered (lossy-decoded)");
	});

	it("a body over the download cap is never buffered — honest marker, no OOM", async () => {
		const r = await webFetch(`${base}/huge`);
		assert.match(r.content, /^\(content not buffered — exceeds \d+\.\d+MB download cap, video\/x-matroska\)/);
		assert.equal(r.error, undefined);
	});

	it("an image response becomes an image block — TUI renders it, model consumes it multimodally", async () => {
		const r = await webFetch(`${base}/photo.png`);
		assert.ok(r.image, "image payload present");
		assert.equal(r.image?.mimeType, "image/png");
		assert.match(r.content, /^Image fetched: image\/png/);
		assert.equal(r.error, undefined);
	});

	it("oversized raw source is not inlined either — raw semantics are artifact semantics", async () => {
		const r = await webFetch(`${base}/big.html`, { raw: true });
		assert.match(r.content, /^\(content not inlined — \d+(\.\d+)?KB, text\/html\)/);
		assert.ok(!r.content.includes("lorem ipsum"), "no source preview");
		assert.match(r.content, /full output: \/tmp\/pi-stash-/);
	});

	it("oversized non-web content is not inlined — stash + pointer, read takes over", async () => {
		const r = await webFetch(`${base}/big.json`);
		assert.match(r.content, /^\(content not inlined — \d+(\.\d+)?KB, application\/json\)/);
		assert.match(r.content, /full output: \/tmp\/pi-stash-/);
		assert.ok(!r.content.includes("item-"), "no body preview — the artifact is the file");
		assert.ok(r.outputPath?.startsWith("/tmp/pi-stash-"));
	});

	it("web-page markdown keeps the pi contract: capped preview + truncation pointer", async () => {
		const r = await webFetch(`${base}/big.html`);
		assert.ok(r.content.includes("lorem ipsum"), "head preview kept for relevance judgement");
		assert.match(r.content, /\(output truncated — full output: \/tmp\/pi-stash-.*\.txt\)/);
	});

	after(() => listener.close());
});
