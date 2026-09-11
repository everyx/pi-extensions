import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ocrBudgetMs } from "../../ocr/engines/rapidocr/engine.js";
import { createRapidOcr, keepConfident, parseOcrOutput } from "../../ocr/engines/rapidocr/page.js";
import type { RunCli } from "../../run.js";
import { fakeRun } from "../helpers.js";

/** The bridge's line for one page. */
const line = (n: number, lines: string[], scores: number[]) => JSON.stringify({ n, lines, scores });

const engine = (opts: { run?: RunCli; textScore?: number } = {}) =>
	createRapidOcr({
		run: opts.run ?? fakeRun().run,
		scriptPath: "/pkg/rapidocr_bridge.py",
		...(opts.textScore !== undefined ? { textScore: opts.textScore } : {}),
	});

describe("parseOcrOutput — bridge JSONL", () => {
	it("reads one line per page, in file order", () => {
		const out = parseOcrOutput(`${line(0, ["a"], [0.9])}\n${line(1, ["b", "c"], [0.8, 0.7])}\n`);
		assert.deepEqual(out, [
			{ n: 0, lines: ["a"], scores: [0.9] },
			{ n: 1, lines: ["b", "c"], scores: [0.8, 0.7] },
		]);
	});

	it("ignores noise: blank lines, warnings, and a half-written line at the kill boundary", () => {
		const out = parseOcrOutput(`some python warning\n${line(0, ["a"], [1])}\n{"n":1,"lines":["par`);
		assert.deepEqual(out, [{ n: 0, lines: ["a"], scores: [1] }]);
	});

	it("carries a per-page error", () => {
		assert.deepEqual(parseOcrOutput(`${JSON.stringify({ n: 0, error: "bad image" })}\n`), [
			{ n: 0, error: "bad image" },
		]);
	});
});

describe("keepConfident", () => {
	it("drops lines below the confidence floor (non-text images)", () => {
		// Reproduced: an illustration yields a junk line at 0.82, noise yields none.
		assert.deepEqual(keepConfident({ n: 0, lines: ["_", "real"], scores: [0.2, 0.9] }, 0.5), ["real"]);
	});

	it("treats a missing score as confident (older bridge)", () => {
		assert.deepEqual(keepConfident({ n: 0, lines: ["a", "b"] }, 0.5), ["a", "b"]);
	});
});

describe("rapidocr engine", () => {
	it("available(): probes interpreters in order, caches the first that imports", async () => {
		const { run, calls } = fakeRun((cmd) => (cmd === "python3" ? { code: 1 } : { code: 0 }));
		const e = engine({ run });
		assert.equal(await e.available(), true);
		assert.equal(await e.available(), true);
		assert.deepEqual(
			calls.map((c) => c.cmd),
			["python3", "python"],
			"probed once, cached after",
		);
	});

	it("available(): no interpreter with rapidocr installed", async () => {
		const { run } = fakeRun(() => ({ code: 1 }));
		assert.equal(await engine({ run }).available(), false);
	});

	it("recognize: one process for the whole batch, results 1:1 with images", async () => {
		const { run, calls } = fakeRun((_cmd, args) =>
			args[0] === "-c" ? { code: 0 } : { stdout: `${line(0, ["first"], [0.9])}\n${line(1, ["second"], [0.8])}\n` },
		);
		const e = engine({ run });
		const res = await e.recognize(["/a/1.png", "/a/2.png"]);
		assert.deepEqual(res, { ok: true, pages: [{ text: "first" }, { text: "second" }] });
		assert.deepEqual(calls.at(-1)?.args, ["/pkg/rapidocr_bridge.py", "/a/1.png", "/a/2.png"]);
		assert.equal(calls.length, 2, "one interpreter probe + one batch run");
	});

	it("recognize: an empty result is a page with no text, not a failure (photo page)", async () => {
		const { run } = fakeRun(() => ({ stdout: `${line(0, [], [])}\n` }));
		assert.deepEqual(await engine({ run }).recognize(["/a/p.png"]), { ok: true, pages: [{ text: "" }] });
	});

	it("recognize: engine not installed — nothing is attempted", async () => {
		const { run, calls } = fakeRun(() => ({ code: null, stderr: "spawn python3 ENOENT" }));
		assert.deepEqual(await engine({ run }).recognize(["/a/1.png"]), { ok: false, reason: "engine-missing" });
		assert.equal(calls.length, 2, "the two probes only — no run attempted");
	});

	it("recognize: timeout salvages the pages that finished, marks the rest", async () => {
		const { run } = fakeRun((_cmd, args) =>
			args[0] === "-c" ? { code: 0 } : { code: null, timedOut: true, stdout: `${line(0, ["done"], [0.9])}\n` },
		);
		const res = await engine({ run }).recognize(["/a/1.png", "/a/2.png", "/a/3.png"]);
		assert.deepEqual(res, {
			ok: true,
			pages: [{ text: "done" }, { text: "", error: "timeout" }, { text: "", error: "timeout" }],
		});
	});

	it("recognize: 整批都失败且 stderr 为空 → detail 用第一页自己的错误（否则只剩一句 failed）", async () => {
		const { run } = fakeRun(() => ({
			stdout: '{"n":0,"error":"unrecognized rapidocr output shape"}\n',
		}));
		const r = await engine({ run }).recognize(["/a.png"]);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.reason, "failed");
			assert.match(r.detail ?? "", /unrecognized rapidocr output shape/, "别把唯一的诊断丢掉");
		}
	});

	it("recognize: a run that produced nothing usable reports the run, with detail", async () => {
		const { run } = fakeRun((_cmd, args) =>
			args[0] === "-c" ? { code: 0 } : { code: 1, stderr: "ModuleNotFoundError: no module named rapidocr" },
		);
		const res = await engine({ run }).recognize(["/a/1.png"]);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.equal(res.reason, "failed");
			assert.match(res.detail ?? "", /ModuleNotFoundError/);
		}
	});

	it("recognize: a per-page bridge error is that page's error, not the run's", async () => {
		const { run } = fakeRun(() => ({
			stdout: `${line(0, ["good"], [0.9])}\n${JSON.stringify({ n: 1, error: "cannot identify image file" })}\n`,
		}));
		const res = await engine({ run }).recognize(["/a/1.png", "/a/2.png"]);
		assert.deepEqual(res, {
			ok: true,
			pages: [{ text: "good" }, { text: "", error: "cannot identify image file" }],
		});
	});

	it("recognize: no images — no process at all", async () => {
		const { run, calls } = fakeRun();
		assert.deepEqual(await engine({ run }).recognize([]), { ok: true, pages: [] });
		assert.equal(calls.length, 0);
	});
});

describe("rapidocr engine — probe caching", () => {
	it("预算耗尽导致的探测失败不缓存（否则整个会话都被告知去装已经装好的东西）", async () => {
		let probes = 0;
		const { run } = fakeRun((_cmd, args) => {
			if (args[0] === "-c") {
				probes++;
				return probes === 1 ? { code: null, timedOut: true } : { code: 0 };
			}
			return { stdout: `${line(0, ["ok"], [1])}\n` };
		});
		const e = engine({ run });
		assert.equal(await e.available({ timeoutMs: 5 }), false, "这次探测没有结论");
		assert.equal(await e.available(), true, "下次必须重探——引擎其实装着");
	});

	it("所有解释器都答了且都没有 rapidocr，才是真的没装（可缓存）", async () => {
		let probes = 0;
		const { run } = fakeRun((_cmd, args) => {
			if (args[0] === "-c") {
				probes++;
				return { code: 1 };
			}
			return {};
		});
		const e = engine({ run });
		assert.equal(await e.available(), false);
		assert.equal(await e.available(), false);
		assert.equal(probes, 2, "两个解释器各探一次，结论被缓存");
	});
});

describe("ocrBudgetMs — 本地恢复的时间预算（PI_READ_DOC_OCR_TIMEOUT_MS）", () => {
	it("未设置 / 非法 / 非正数 → 默认预算", () => {
		delete process.env.PI_READ_DOC_OCR_TIMEOUT_MS;
		assert.equal(ocrBudgetMs(), 120_000);
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "abc";
		assert.equal(ocrBudgetMs(), 120_000);
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "0";
		assert.equal(ocrBudgetMs(), 120_000, "0 不是「不限制」，是配置错误");
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "-5";
		assert.equal(ocrBudgetMs(), 120_000);
		delete process.env.PI_READ_DOC_OCR_TIMEOUT_MS;
	});

	it("合法值生效", () => {
		process.env.PI_READ_DOC_OCR_TIMEOUT_MS = "30000";
		assert.equal(ocrBudgetMs(), 30_000);
		delete process.env.PI_READ_DOC_OCR_TIMEOUT_MS;
	});
});
