/**
 * Tests for the stateful RPC transport (rpc-client.ts) against a mock
 * child process (test/fixtures/rpc-mock.js).
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
import { RpcClient } from "../rpc-client.js";

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
			// get_state is delayed 60ms, abort 10ms — the abort response lands
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
