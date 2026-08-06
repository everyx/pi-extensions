import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadRunners, reapRunners, runnerFilePath, saveRunners } from "../runners.js";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runners-"));
}

test("loadRunners returns [] for a missing or corrupt file", () => {
	const dir = tmpDir();
	assert.deepEqual(loadRunners(runnerFilePath(dir)), []);
	fs.writeFileSync(runnerFilePath(dir), "not json{{");
	assert.deepEqual(loadRunners(runnerFilePath(dir)), []);
});

test("saveRunners round-trips records", () => {
	const dir = tmpDir();
	const file = runnerFilePath(dir);
	saveRunners(file, [
		{ pid: 42, agentId: "a1", title: "t", startedAt: 1 },
		{ pid: 43, agentId: "a2", title: "t2", startedAt: 2 },
	]);
	assert.deepEqual(loadRunners(file), [
		{ pid: 42, agentId: "a1", title: "t", startedAt: 1 },
		{ pid: 43, agentId: "a2", title: "t2", startedAt: 2 },
	]);
});

test("reapRunners terminates live runner processes and clears the ledger", async () => {
	const dir = tmpDir();
	const file = runnerFilePath(dir);
	// Detached so -pid signals the group (same as the real rpc children).
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	const pid = child.pid!;
	const exited = new Promise<number>((resolve) => child.on("exit", () => resolve(pid)));
	saveRunners(file, [{ pid, agentId: "a1", title: "t", startedAt: Date.now() }]);

	assert.equal(reapRunners(file), 1, "one runner signalled");
	assert.deepEqual(loadRunners(file), [], "ledger cleared");
	assert.equal(await exited, pid, "the child was terminated");

	// A second reap has nothing left to kill.
	assert.equal(reapRunners(file), 0);
});

test("reapRunners skips pids that are already gone", () => {
	const dir = tmpDir();
	const file = runnerFilePath(dir);
	saveRunners(file, [{ pid: 999_999, agentId: "x", title: "t", startedAt: 1 }]);
	assert.equal(reapRunners(file), 0);
	assert.deepEqual(loadRunners(file), []);
});
