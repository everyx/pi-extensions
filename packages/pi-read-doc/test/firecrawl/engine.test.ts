/**
 * Tests for the firecrawl engine (ocr/engines/firecrawl/engine.ts): the one place in
 * this package that uploads a document, and the one that has to behave when the
 * service says "not now".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServeContext } from "../../convert.js";
import { createFirecrawlEngine, type FirecrawlEngineDeps } from "../../ocr/engines/firecrawl/engine.js";
import type { FirecrawlGate, FirecrawlSkip } from "../../ocr/engines/firecrawl/gate.js";

const ctx = (pages: number[] = [3], pageCount = 3): ServeContext => ({
	path: "a.pdf",
	ext: ".pdf",
	pages,
	pageCount,
	now: new Date(2026, 8, 11),
});

function deps(overrides: FirecrawlEngineDeps = {}, parked: FirecrawlSkip | null = null) {
	const uploads: string[] = [];
	const recorded: FirecrawlSkip[] = [];
	const gate: FirecrawlGate = {
		async skipped() {
			return parked;
		},
		async record(skip) {
			recorded.push(skip);
		},
	};
	const engine = createFirecrawlEngine({
		upload: async (path) => {
			uploads.push(path);
			return "parse markdown";
		},
		gate,
		limit: async (fn) => fn(),
		...overrides,
	});
	return { engine, uploads, recorded };
}

describe("firecrawl engine — the only upload call site", () => {
	it("被停摆 → 根本不发请求，并把原因与日期说出来", async () => {
		const { engine, uploads } = deps({}, { until: new Date(2026, 9, 1).getTime(), reason: "credits exhausted" });
		const out = await engine.serve(ctx());
		assert.equal(out.ok, false);
		assert.equal(uploads.length, 0, "停摆期间不浪费请求，更不上传");
		assert.ok(out.ok === false && "hint" in out && /paused until/.test(out.hint ?? ""));
		assert.ok(out.ok === false && "hint" in out && /credits exhausted/.test(out.hint ?? ""));
	});

	it("成功 → 整份文档一个块，来源句点名引擎并说明已上传", async () => {
		const { engine, uploads } = deps();
		const out = await engine.serve(ctx([3], 3));
		assert.equal(out.ok, true);
		if (out.ok) {
			assert.deepEqual(out.blocks, [{ pages: [1, 2, 3], text: "parse markdown" }]);
			assert.match(out.hint ?? "", /pages 3 were read by firecrawl OCR/);
			assert.match(out.hint ?? "", /was uploaded/);
		}
		assert.deepEqual(uploads, ["a.pdf"]);
	});

	it("整份都要 OCR 时说 every page", async () => {
		const { engine } = deps();
		const out = await engine.serve(ctx([1, 2, 3], 3));
		assert.ok(out.ok === true && /every page was/.test(out.hint ?? ""));
	});

	it("配额信号 → 记下停摆，并给出无日期的那句", async () => {
		const { engine, recorded } = deps({
			upload: async () => {
				throw new Error("Firecrawl Parse is out of credits: nope");
			},
		});
		const out = await engine.serve(ctx([1], 1));
		assert.equal(recorded.length, 1, "记下停摆，否则每次读取都会重试上传");
		assert.equal(new Date(recorded[0]?.until ?? 0).getMonth(), 9, "停到 10 月");
		assert.ok(out.ok === false && "hint" in out && /firecrawl OCR paused: /.test(out.hint ?? ""));
	});

	it("key 被拒 → 提示检查 key（静默会藏住一个坏配置）", async () => {
		const { engine } = deps({
			upload: async () => {
				throw new Error("Firecrawl Parse rejected the API key: bad");
			},
		});
		const out = await engine.serve(ctx([1], 1));
		assert.ok(out.ok === false && "hint" in out && /FIRECRAWL_API_KEY/.test(out.hint ?? ""));
	});

	it("瞬时失败（500/网络）→ 不给 hint：用户无从下手", async () => {
		const { engine } = deps({
			upload: async () => {
				throw new Error("Firecrawl Parse: 500");
			},
		});
		const out = await engine.serve(ctx([1], 1));
		assert.equal(out.ok, false);
		assert.equal(out.ok === false && "hint" in out ? out.hint : undefined, undefined);
	});

	it("限流包住上传调用（Parse 要 2 qps）", async () => {
		let wrapped = 0;
		const { engine, uploads } = deps({
			limit: async (fn) => {
				wrapped++;
				return fn();
			},
		});
		await engine.serve(ctx());
		assert.equal(wrapped, 1);
		assert.equal(uploads.length, 1);
	});
});
