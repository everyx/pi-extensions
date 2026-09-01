/**
 * Tests for the bsk browser lifecycle (search/bsk-browser.ts) — the
 * ownership decision machine, driven with fakes (no real browser):
 *   - ensureConnected: already connected / auto-launch / launch failure
 *   - stopSession close policy: self-launched → kill after delay; user's
 *     browser → never touched; other sessions active → no kill; timer reset
 *   - session-id parsing across bsk version shapes
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BskBrowser, type BskRunner, parseBskSessionId } from "../search/bsk-browser.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeState {
	/** A browser is connected to the bsk daemon. */
	browsersConnected: boolean;
	/** Another (engine's) session is still active — blocks the close. */
	sessionsActive: boolean;
	/** Pid the launcher reports; undefined = no candidate started. */
	launchPid: number | undefined;
	/** The launched browser connects (seen by the next poll). */
	connectOnLaunch: boolean;
	/** `bsk session start` fails. */
	startFails: boolean;
	launchCalls: number;
	killPids: number[];
}

const fresh = (over: Partial<FakeState> = {}): FakeState => ({
	browsersConnected: false,
	sessionsActive: false,
	launchPid: undefined,
	connectOnLaunch: false,
	startFails: false,
	launchCalls: 0,
	killPids: [],
	...over,
});

/** Wire a fake bsk CLI + launcher/killer into a fresh BskBrowser. */
function makeFake(state: FakeState, closeDelayMs = 10, pollIntervalMs = 5) {
	const calls: string[][] = [];
	const runBsk: BskRunner = async (args) => {
		calls.push(args);
		if (args[0] === "browsers") {
			return {
				ok: true,
				stdout: state.browsersConnected ? '[{"instance_id":"i1","browser_name":"Chrome"}]' : "[]",
				stderr: "",
			};
		}
		if (args[0] === "session") {
			if (args[1] === "start") {
				return state.startFails
					? { ok: false, stdout: "", stderr: "boom" }
					: { ok: true, stdout: JSON.stringify({ sessionId: "s1" }), stderr: "" };
			}
			if (args[1] === "list") {
				return { ok: true, stdout: state.sessionsActive ? '[{"id":"s9"}]' : "[]", stderr: "" };
			}
		}
		return { ok: true, stdout: "", stderr: "" }; // session stop
	};
	const lifecycle = new BskBrowser({
		runBsk,
		launchBrowser: async () => {
			state.launchCalls++;
			if (state.connectOnLaunch) state.browsersConnected = true;
			return state.launchPid;
		},
		killBrowser: (pid) => {
			state.killPids.push(pid);
		},
		closeDelayMs,
		pollIntervalMs,
	});
	return { lifecycle, calls, state };
}

describe("BskBrowser.ensureConnected", () => {
	it("accepts an already-connected browser without launching", async () => {
		const { lifecycle, state } = makeFake(fresh({ browsersConnected: true }));
		const r = await lifecycle.ensureConnected(40);
		assert.deepEqual(r, { ok: true, detail: "browser connected" });
		assert.equal(state.launchCalls, 0);
	});

	it("auto-launches when none is connected (detail names the launch)", async () => {
		const { lifecycle, state } = makeFake(fresh({ launchPid: 4242, connectOnLaunch: true }));
		const r = await lifecycle.ensureConnected(40);
		assert.deepEqual(r, { ok: true, detail: "browser auto-launched and connected" });
		assert.equal(state.launchCalls, 1);
	});

	it("launches at most once, and reports a distinct error when no browser could start", async () => {
		const { lifecycle, state } = makeFake(fresh({ launchPid: undefined }));
		const r = await lifecycle.ensureConnected(20);
		assert.equal(r.ok, false);
		assert.equal(r.detail, "no Chromium-family browser found to launch; open one manually");
		assert.equal(state.launchCalls, 1, "one launch attempt, then poll only");
	});

	it("reports a distinct error when the launched browser never connects", async () => {
		const { lifecycle } = makeFake(fresh({ launchPid: 4242 }));
		const r = await lifecycle.ensureConnected(20);
		assert.equal(r.ok, false);
		assert.equal(r.detail, "launched browser but the bsk extension did not connect");
	});
});

describe("BskBrowser sessions", () => {
	it("startSession: ensures a browser, then starts a session (id from JSON)", async () => {
		const { lifecycle, calls } = makeFake(fresh({ browsersConnected: true }));
		const id = await lifecycle.startSession();
		assert.equal(id, "s1");
		assert.ok(calls.some((a) => a.join(" ") === "session start --json"));
	});

	it("startSession: a start failure throws the bsk error", async () => {
		const { lifecycle } = makeFake(fresh({ browsersConnected: true, startFails: true }));
		await assert.rejects(() => lifecycle.startSession(), /bsk session start failed/);
	});

	it("stopSession: a self-launched browser is killed after the delay", async () => {
		const { lifecycle, state } = makeFake(fresh({ launchPid: 4242, connectOnLaunch: true }));
		await lifecycle.startSession();
		await lifecycle.stopSession("s1");
		await sleep(30);
		assert.deepEqual(state.killPids, [4242]);
	});

	it("stopSession: a user-opened browser is never touched", async () => {
		const { lifecycle, calls, state } = makeFake(fresh({ browsersConnected: true }));
		await lifecycle.stopSession("s1");
		await sleep(30);
		assert.deepEqual(state.killPids, []);
		assert.ok(calls.some((a) => a.join(" ") === "session stop s1"));
	});

	it("stopSession: no kill while another session is still active", async () => {
		const { lifecycle, state } = makeFake(fresh({ launchPid: 4242, connectOnLaunch: true, sessionsActive: true }));
		await lifecycle.startSession();
		await lifecycle.stopSession("s1");
		await sleep(30);
		assert.deepEqual(state.killPids, [], "another engine's session still draining");
	});

	it("stopSession twice: the close timer resets, kill happens once", async () => {
		const { lifecycle, state } = makeFake(fresh({ launchPid: 4242, connectOnLaunch: true }));
		await lifecycle.startSession();
		await lifecycle.stopSession("s1");
		await sleep(5); // half the close delay — first timer still pending
		await lifecycle.stopSession("s2"); // resets the timer
		await sleep(30);
		assert.deepEqual(state.killPids, [4242], "one kill, not two");
	});
});

describe("parseBskSessionId", () => {
	it("reads the id under each version's key", () => {
		assert.equal(parseBskSessionId('{"sessionId":"s1"}'), "s1");
		assert.equal(parseBskSessionId('{"session_id":"s2"}'), "s2");
		assert.equal(parseBskSessionId('{"id":"s3"}'), "s3");
	});

	it("falls back to raw stdout (non-JSON), rejects empty", () => {
		assert.equal(parseBskSessionId("  raw-id  "), "raw-id");
		assert.equal(parseBskSessionId(""), undefined);
		assert.equal(parseBskSessionId("   "), undefined);
	});
});
