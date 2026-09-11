/**
 * Tests for the registry (ocr/engines/registry.ts): how a configured name
 * becomes a live engine — and the guarantee issue #27 rests on, that a config
 * which does not name an engine never builds it.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { EngineId } from "../convert.js";
import { parseOcrEngine } from "../index.js";
import { ENGINE_FACTORIES, type EngineFactory, engineFor, enginesFor, resetEngines } from "../ocr/engines/registry.js";

/** A factory table that records which engines got built. */
function recording() {
	const built: EngineId[] = [];
	const factories = Object.fromEntries(
		(Object.keys(ENGINE_FACTORIES) as EngineId[]).map((id) => [
			id,
			(() => {
				built.push(id);
				return {
					id,
					async serve() {
						return { ok: false as const, notApplicable: true as const };
					},
				};
			}) as EngineFactory,
		]),
	) as Record<EngineId, EngineFactory>;
	return { factories, built };
}

describe("registry — 配置名 → 活着的引擎", () => {
	it("enginesFor 保持配置顺序（顺序即策略）", () => {
		resetEngines();
		assert.deepEqual(
			enginesFor(["rapidocr", "firecrawl"]).map((e) => e.id),
			["rapidocr", "firecrawl"],
		);
	});

	it("懒建且进程内复用：同一个 id 两次拿到同一实例", () => {
		resetEngines();
		assert.equal(engineFor("rapidocr"), engineFor("rapidocr"));
	});

	it("resetEngines 清掉实例（下次重建）", () => {
		resetEngines();
		const before = engineFor("rapidocr");
		resetEngines();
		assert.notEqual(engineFor("rapidocr"), before);
	});

	it("注入的工厂表有自己的实例表：能观察构造了谁，且不碰生产实例", () => {
		const { factories, built } = recording();
		enginesFor(["firecrawl"], factories);
		enginesFor(["firecrawl"], factories);
		assert.deepEqual(built, ["firecrawl"], "同一张表复用实例，不重复构造");
	});

	it("issue #27 主证据①：rapidocr 配置 → 只构造 rapidocr，firecrawl 工厂零调用", () => {
		const { factories, built } = recording();
		const config = parseOcrEngine("rapidocr");
		assert.ok(!("invalid" in config));
		const engines = enginesFor(config.engines, factories);
		assert.deepEqual(
			engines.map((e) => e.id),
			["rapidocr"],
		);
		assert.deepEqual(built, ["rapidocr"], "firecrawl 引擎根本没被构造");
	});

	it("对照组：firecrawl,rapidocr 两个都会被构造（证明观察手段有效）", () => {
		const { factories, built } = recording();
		const config = parseOcrEngine("firecrawl,rapidocr");
		assert.ok(!("invalid" in config));
		enginesFor(config.engines, factories);
		assert.deepEqual(built, ["firecrawl", "rapidocr"]);
	});

	it('issue #27 主证据②：全包只有一处上传调用点（`ocr: "hosted"`）', async () => {
		// A regression nail, not a proof: adding an upload call anywhere else must
		// fail here first, and the fix is to update this test deliberately.
		const needle = ["ocr:", '"hosted"'].join(" ");
		const root = fileURLToPath(new URL("..", import.meta.url));
		const sources: string[] = [];
		async function walk(dir: string): Promise<void> {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) await walk(full);
				else if (entry.name.endsWith(".ts") && !full.includes(`${sep}test${sep}`)) sources.push(full);
			}
		}
		await walk(root);
		const hits: string[] = [];
		for (const file of sources) {
			const text = await readFile(file, "utf-8");
			if (text.includes(needle)) hits.push(relative(root, file));
		}
		assert.deepEqual(hits, [join("ocr", "engines", "firecrawl", "engine.ts")]);
	});
});
