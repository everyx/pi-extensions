import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHolder, type Spawner, WakeLock } from "../wake-lock.js";

const PID = 4242;

describe("buildHolder", () => {
	it("darwin: caffeinate with idle assertion, waiting on our pid", () => {
		const plan = buildHolder("darwin", { display: false, watcherPid: PID });
		assert.deepEqual(plan, { cmd: "caffeinate", args: ["-i", "-w", String(PID)] });
	});

	it("darwin: display option adds -d", () => {
		const plan = buildHolder("darwin", { display: true, watcherPid: PID });
		assert.deepEqual(plan?.args, ["-i", "-d", "-w", String(PID)]);
	});

	it("linux: systemd-inhibit blocking sleep+idle, shell loop watching our pid", () => {
		const plan = buildHolder("linux", { display: false, watcherPid: PID });
		assert.equal(plan?.cmd, "systemd-inhibit");
		assert.ok(plan?.args.includes("sleep:idle"));
		const sh = plan?.args.at(-1) ?? "";
		assert.match(sh, new RegExp(`kill -0 ${PID}`));
		assert.match(sh, /sleep 5/);
	});

	it("win32: PowerShell EncodedCommand carrying SetThreadExecutionState + pid watch", () => {
		const plan = buildHolder("win32", { display: false, watcherPid: PID });
		assert.equal(plan?.cmd, "powershell");
		const encoded = plan?.args.at(-1) ?? "";
		const script = Buffer.from(encoded, "base64").toString("utf16le");
		assert.match(script, /SetThreadExecutionState\(0x80000001\)/); // ES_CONTINUOUS | SYSTEM_REQUIRED
		assert.match(script, new RegExp(`Get-Process -Id ${PID}`));
	});

	it("win32: display option raises DISPLAY_REQUIRED (0x80000003)", () => {
		const plan = buildHolder("win32", { display: true, watcherPid: PID });
		const script = Buffer.from(plan?.args.at(-1) ?? "", "base64").toString("utf16le");
		assert.match(script, /SetThreadExecutionState\(0x80000003\)/);
	});

	it("unsupported platform: no backend", () => {
		assert.equal(buildHolder("freebsd", { display: false, watcherPid: PID }), null);
	});
});

/** Minimal fake child standing in for the holder process. */
function fakeChild() {
	return {
		killed: false,
		on() {},
		kill() {
			this.killed = true;
		},
	};
}

describe("WakeLock", () => {
	function harness() {
		const children: Array<ReturnType<typeof fakeChild>> = [];
		const warnings: unknown[] = [];
		const spawner: Spawner = () => {
			const c = fakeChild();
			children.push(c);
			return c as never;
		};
		const lock = new WakeLock("linux", { spawn: spawner, warn: (f) => warnings.push(f) });
		return { lock, children, warnings };
	}

	it("acquire spawns one holder; release kills it", () => {
		const { lock, children } = harness();
		lock.acquire();
		assert.equal(children.length, 1);
		assert.equal(lock.active, true);
		lock.release();
		assert.equal(children[0].killed, true);
		assert.equal(lock.active, false);
	});

	it("overlapping acquires collapse — one release drops it (idempotent)", () => {
		const { lock, children } = harness();
		lock.acquire();
		lock.acquire();
		assert.equal(children.length, 1);
		lock.release();
		assert.equal(lock.active, false, "idempotent: one release is enough");
	});

	it("release when idle is a no-op", () => {
		const { lock, children } = harness();
		lock.release();
		assert.equal(children.length, 0);
		lock.acquire();
		lock.release();
		lock.release();
		assert.equal(lock.active, false);
	});

	it("missing backend warns once and stays inactive without spawning", () => {
		const { children, warnings } = harness();
		const bsd = new WakeLock("freebsd", { spawn: (() => fakeChild()) as never, warn: (f) => warnings.push(f) });
		bsd.acquire();
		bsd.acquire();
		assert.equal(children.length, 0);
		assert.deepEqual(warnings, [{ reason: "no-backend", platform: "freebsd" }]);
	});
});
