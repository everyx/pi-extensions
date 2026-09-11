/**
 * Tests for the hosted gate (hosted-gate.ts): which condition a failure names,
 * how long it parks hosted, and what it refuses to park on. The gate learns
 * this from the message the service produced — a reworded message may cost the
 * optimization, never correct behaviour.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostedExhaustion, hostedKeyRejected } from "../hosted-gate.js";

describe("hostedExhaustion — 哪种额度状况，暂停多久", () => {
	const now = new Date(2026, 8, 11, 14, 30); // 2026-09-11 14:30 local

	it("402 out of credits → 停到本月底（额度不会在月内回来）", () => {
		const skip = hostedExhaustion("Firecrawl Parse is out of credits: plan credits exhausted", now);
		assert.ok(skip);
		assert.equal(new Date(skip.until).getMonth(), 9, "10 月 1 日");
		assert.equal(new Date(skip.until).getDate(), 1);
		assert.match(skip.reason, /credits exhausted/);
	});

	it("429 keyless → 只停到次日（免费层是按 IP 按天的上限）", () => {
		const skip = hostedExhaustion("Firecrawl Parse keyless limit reached, set FIRECRAWL_API_KEY: too many", now);
		assert.ok(skip);
		assert.equal(new Date(skip.until).getDate(), 12, "明天");
		assert.equal(new Date(skip.until).getHours(), 0);
	});

	it("429 keyed（每分钟频率限制）→ 不停摆，稍后重试即可", () => {
		assert.equal(hostedExhaustion("Firecrawl Parse rate limit reached: slow down (keyed)", now), null);
	});

	it("网络/500/其他 → 不停摆", () => {
		assert.equal(hostedExhaustion("Firecrawl Parse: fetch failed", now), null);
		assert.equal(hostedExhaustion("Firecrawl Parse: internal error", now), null);
	});

	it("key 被拒是配置问题，不是额度", () => {
		const msg = "Firecrawl Parse rejected the API key: invalid token";
		assert.equal(hostedExhaustion(msg, now), null);
		assert.equal(hostedKeyRejected(msg), true);
		assert.equal(hostedKeyRejected("Firecrawl Parse is out of credits"), false);
	});
});
