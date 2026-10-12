/**
 * Tests for the stateful RPC transport (rpc-client.ts) against a mock
 * child process (test/fixtures/rpc-mock.js), plus the pure spawn-target
 * choice (which executable runs the child pi, and with what argv prefix).
 *
 * Covers the two real transport bugs found in code review:
 *  1. concurrent commands must correlate by unique command id — a shared id
 *     (e.g. the agent id) lets a later command steal an earlier waiter and
 *     mismatches responses;
 *  2. raw stdout Buffer chunks must go through StringDecoder — decoding with
 *     toString("utf8") first corrupts multibyte characters split across chunk
 *     boundaries.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient, spawnTarget } from "../rpc-client.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rpc-mock.js");

function makeClient(): RpcClient {
	return new RpcClient({ command: "node", args: [FIXTURE], cwd: path.dirname(FIXTURE) });
}

async function close(client: RpcClient): Promise<void> {
	client.endInput();
	await client.waitForExit();
}

describe("RpcClient — command correlation", () => {
	it("correlates concurrent commands by unique id even when responses arrive out of order", async () => {
		const client = makeClient();
		try {
			// get_state is delayed 60ms, abort 40ms — the abort response lands
			// first. With a shared id the second sendCommand would overwrite the
			// first waiter and the late get_state response would resolve the
			// abort call (mismatch).
			const [state, abort] = await Promise.all([
				client.sendCommand({ type: "get_state" }),
				client.sendCommand({ type: "abort" }),
			]);
			assert.equal(state.command, "get_state");
			assert.equal(abort.command, "abort");
		} finally {
			await close(client);
		}
	});

	it("keeps each waiter bound to its own timeout", async () => {
		const client = makeClient();
		try {
			const [abort, prompt] = await Promise.all([
				client.sendCommand({ type: "abort" }),
				client.sendCommand({ type: "get_last_assistant_text" }),
			]);
			assert.equal(abort.command, "abort");
			assert.equal(prompt.command, "get_last_assistant_text");
		} finally {
			await close(client);
		}
	});
});

describe("RpcClient — UTF-8 framing", () => {
	it("reassembles multibyte characters split across stdout chunks", async () => {
		const client = makeClient();
		try {
			const response = await client.sendCommand({ type: "split_utf8" } as never);
			assert.equal(response.success, true);
			assert.deepEqual(response.data, { file: "路径/文件😀" });
		} finally {
			await close(client);
		}
	});
});

// ── Which executable to spawn ────────────────────────────
//
// `pi` is an npm bin shim. On Windows the bare name resolves through PATH to
// npm's extensionless sh script, which Node cannot execute (ENOENT), and
// `pi.cmd` needs cmd.exe (EINVAL) — so the child pi runs as the CLI script
// through the node that runs us, the same thing the shim does itself.

describe("spawnTarget — the executable behind the child pi", () => {
	it("Unix spawns the shim on PATH, with no argv prefix", () => {
		assert.deepEqual(spawnTarget({ platform: "linux", scriptPath: "/usr/lib/node_modules/pi/dist/bundle/cli.js" }), {
			command: "pi",
			argvPrefix: [],
		});
	});

	it("Windows runs the CLI script through node (the shim's own trick)", () => {
		const scriptPath =
			"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
		assert.deepEqual(spawnTarget({ platform: "win32", execPath: "C:\\node\\node.exe", scriptPath }), {
			command: "C:\\node\\node.exe",
			argvPrefix: [scriptPath],
		});
	});

	it("Windows with a non-script launcher (bundled binary) falls back to the shim", () => {
		assert.deepEqual(spawnTarget({ platform: "win32", execPath: "C:\\pi\\pi.exe", scriptPath: "C:\\pi\\pi.exe" }), {
			command: "pi",
			argvPrefix: [],
		});
	});

	it("Windows absolutizes the script — the child's cwd is the agent's, not ours", () => {
		const target = spawnTarget({
			platform: "win32",
			execPath: "C:\\node\\node.exe",
			scriptPath: "dist\\bundle\\cli.js",
		});
		assert.equal(target.command, "C:\\node\\node.exe");
		assert.equal(target.argvPrefix.length, 1);
		assert.ok(path.win32.isAbsolute(target.argvPrefix[0]), `absolute: ${target.argvPrefix[0]}`);
		assert.match(target.argvPrefix[0], /dist\\bundle\\cli\.js$/);
	});

	it("an explicit command is the caller's business — never rewritten", () => {
		assert.deepEqual(spawnTarget({ command: "node", platform: "win32", execPath: "x", scriptPath: "y.js" }), {
			command: "node",
			argvPrefix: [],
		});
	});
});
