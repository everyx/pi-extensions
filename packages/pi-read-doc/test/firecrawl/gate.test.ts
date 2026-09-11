/**
 * Tests for the firecrawl gate (ocr/engines/firecrawl/gate.ts): which condition
 * a failure names, how long it parks the engine, and what it refuses to park
 * on. The gate learns this from the message the service produced — a reworded
 * message may cost the optimization, never correct behaviour.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileFirecrawlGate, firecrawlExhaustion, firecrawlKeyRejected } from "../../ocr/engines/firecrawl/gate.js";

describe("firecrawlExhaustion — 哪种额度状况，暂停多久", () => {
	const now = new Date(2026, 8, 11, 14, 30); // 2026-09-11 14:30 local

	it("402 out of credits → 停到本月底（额度不会在月内回来）", () => {
		const skip = firecrawlExhaustion("Firecrawl Parse is out of credits: plan credits exhausted", now);
		assert.ok(skip);
		assert.equal(new Date(skip.until).getMonth(), 9, "10 月 1 日");
		assert.equal(new Date(skip.until).getDate(), 1);
		assert.match(skip.reason, /credits exhausted/);
	});

	it("429 keyless → 只停到次日（免费层是按 IP 按天的上限）", () => {
		const skip = firecrawlExhaustion("Firecrawl Parse keyless limit reached, set FIRECRAWL_API_KEY: too many", now);
		assert.ok(skip);
		assert.equal(new Date(skip.until).getDate(), 12, "明天");
		assert.equal(new Date(skip.until).getHours(), 0);
	});

	it("429 keyed（每分钟频率限制）→ 不停摆，稍后重试即可", () => {
		assert.equal(firecrawlExhaustion("Firecrawl Parse rate limit reached: slow down (keyed)", now), null);
	});

	it("网络/500/其他 → 不停摆", () => {
		assert.equal(firecrawlExhaustion("Firecrawl Parse: fetch failed", now), null);
		assert.equal(firecrawlExhaustion("Firecrawl Parse: internal error", now), null);
	});

	it("key 被拒是配置问题，不是额度", () => {
		const msg = "Firecrawl Parse rejected the API key: invalid token";
		assert.equal(firecrawlExhaustion(msg, now), null);
		assert.equal(firecrawlKeyRejected(msg), true);
		assert.equal(firecrawlKeyRejected("Firecrawl Parse is out of credits"), false);
	});
});

describe("gate file — 状态键迁移", () => {
	it("旧键 { hosted } 仍然被读到（忽略它会让已停摆的用户多上传一次）", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-read-doc-home-"));
		const previous = process.env.HOME;
		process.env.HOME = home;
		try {
			await mkdir(join(home, ".pi"), { recursive: true });
			const until = new Date(Date.now() + 86_400_000).toISOString();
			await writeFile(
				join(home, ".pi", "read-doc.json"),
				JSON.stringify({ hosted: { skipUntil: until, reason: "legacy reason" } }),
				"utf-8",
			);
			const parked = await fileFirecrawlGate.skipped(new Date());
			assert.equal(parked?.reason, "legacy reason", "旧键里的停摆必须继续生效");
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			await rm(home, { recursive: true, force: true });
		}
	});

	it("写入只用新键", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-read-doc-home-"));
		const previous = process.env.HOME;
		process.env.HOME = home;
		try {
			await fileFirecrawlGate.record({ until: Date.now() + 1000, reason: "fresh" });
			const { readFile } = await import("node:fs/promises");
			const raw = JSON.parse(await readFile(join(home, ".pi", "read-doc.json"), "utf-8")) as Record<string, unknown>;
			assert.ok("firecrawl" in raw, "新键");
			assert.ok(!("hosted" in raw), "不再写旧键");
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			await rm(home, { recursive: true, force: true });
		}
	});
});
