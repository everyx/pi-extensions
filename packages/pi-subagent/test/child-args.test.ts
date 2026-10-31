import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildChildArgs, canDelegate, childEnv, readDepth, resumePathError, withPlumbing } from "../agent-process.js";

writeFileSync("/tmp/pi-resume-ok.jsonl", '{"type":"header"}\n');
writeFileSync("/tmp/pi-resume-empty.jsonl", "");
writeFileSync("/tmp/pi-resume-corrupt.jsonl", "not json\n");

describe("buildChildArgs — how the child pi is launched", () => {
	it("a fresh spawn gets its own session dir", () => {
		const args = buildChildArgs({ label: "probe", sessionDir: "/tmp/sessions" });
		assert.deepEqual(args, ["--name", "probe", "--session-dir", "/tmp/sessions"]);
	});

	it("a resumed spawn points at the session file instead", () => {
		const args = buildChildArgs({
			label: "probe",
			sessionDir: "/tmp/sessions",
			resumeSessionPath: "/tmp/sessions/old.jsonl",
		});
		assert.deepEqual(args, ["--name", "probe", "--session", "/tmp/sessions/old.jsonl"]);
		assert.ok(!args.includes("--session-dir"), "one source for where the session lives");
	});

	it("carries the model / thinking / tool restrictions through", () => {
		const args = buildChildArgs({
			label: "probe",
			model: "p/m",
			thinking: "high",
			tools: ["read", "grep"],
		});
		assert.deepEqual(args, [
			"--model",
			"p/m",
			"--thinking",
			"high",
			"--tools",
			"read,grep,agent_send,agent_stop,agent_spawn",
			"--name",
			"probe",
		]);
	});

	it("caps the label so a long title cannot overflow --name", () => {
		const args = buildChildArgs({ label: "x".repeat(200) });
		const name = args[args.indexOf("--name") + 1];
		assert.equal(name?.length, 80);
	});
});

describe("resumePathError — what the boundary can settle before spawning", () => {
	it("accepts a real, non-empty session file", () => {
		assert.equal(resumePathError("/tmp/pi-resume-ok.jsonl"), undefined);
	});

	it("rejects a path that does not exist", () => {
		assert.match(resumePathError("/tmp/pi-resume-missing.jsonl") ?? "", /session not found/);
	});

	it("rejects a directory — pi would answer with a bare EISDIR", () => {
		assert.match(resumePathError("/tmp") ?? "", /not a session file/);
	});

	it("rejects an empty file — pi would silently start a FRESH session", () => {
		// The one that matters: no error from pi, just the wrong context.
		assert.match(resumePathError("/tmp/pi-resume-empty.jsonl") ?? "", /empty/);
	});

	it("leaves the session format to pi", () => {
		// A file that exists and has bytes is pi's call to parse.
		assert.equal(resumePathError("/tmp/pi-resume-corrupt.jsonl"), undefined);
	});
});

describe("delegation depth — who may delegate", () => {
	it("a root session is depth 0, so it may delegate", () => {
		assert.equal(readDepth(undefined), 0);
		assert.ok(readDepth(undefined) < readDepth(undefined, 1), "root sits below the default cap");
	});

	it("reads the depth it was given", () => {
		assert.equal(readDepth("1"), 1);
		assert.equal(readDepth("3"), 3);
	});

	it("a malformed depth falls back instead of poisoning the comparison", () => {
		// NaN would make every comparison false — silently granting or denying
		// delegation for the whole session.
		assert.equal(readDepth("two"), 0);
		assert.equal(readDepth("-1"), 0);
		assert.equal(readDepth("1.5"), 0);
		assert.equal(readDepth("", 1), 1, "blank means unset, not zero");
		assert.equal(readDepth("   ", 1), 1);
	});

	it("decides delegation from depth alone — the table the README promises", () => {
		// [depth, cap] → may delegate. A session at the cap gets no agent_spawn.
		const cases: Array<[number, number, boolean]> = [
			[0, 0, false],
			[0, 1, true],
			[1, 1, false],
			[1, 2, true],
			[2, 2, false],
			[2, 3, true],
			[3, 3, false],
		];
		for (const [depth, cap, expected] of cases) {
			assert.equal(canDelegate(depth, cap), expected, `depth ${depth}, cap ${cap}`);
		}
	});

	it("each spawn hands the child a depth one deeper, with its identity", () => {
		assert.deepEqual(childEnv("max", 0), { PI_SUBAGENT_AGENT_ID: "max", PI_SUBAGENT_DEPTH: "1" });
		assert.deepEqual(childEnv("abe", 1), { PI_SUBAGENT_AGENT_ID: "abe", PI_SUBAGENT_DEPTH: "2" });
	});
});

describe("withPlumbing — a tool whitelist must not cut the child's lifeline", () => {
	it("keeps the control tools on a plain whitelist", () => {
		// The list our own copy recommends lost agent_send, while another
		// guideline tells a stuck child to ask its parent with it.
		assert.deepEqual(withPlumbing(["read", "grep", "find", "ls"]), [
			"read",
			"grep",
			"find",
			"ls",
			"agent_send",
			"agent_stop",
			"agent_spawn",
		]);
	});

	it("does not list a tool twice when the caller named it", () => {
		assert.deepEqual(withPlumbing(["read", "agent_send"]), ["read", "agent_send", "agent_stop", "agent_spawn"]);
	});

	it("leaves an additive list alone — those are the caller's own choices", () => {
		// pi starts an additive list from the default set and applies the
		// additions and removals given; rewriting it would override them.
		assert.deepEqual(withPlumbing(["+codemode", "-write"]), ["+codemode", "-write"]);
	});

	it("does not fight an explicit removal of a control tool", () => {
		// Pinned as a decision: an additive `-agent_send` passes through
		// untouched rather than being "repaired" back in.
		assert.deepEqual(withPlumbing(["-agent_send"]), ["-agent_send"]);
	});

	it("adds nothing when the caller grants everything", () => {
		const args = buildChildArgs({ label: "probe", sessionDir: "/tmp/sessions" });
		assert.ok(!args.includes("--tools"), "no whitelist means no --tools flag");
	});

	it("carries the restored list into the child argv", () => {
		const args = buildChildArgs({ label: "probe", tools: ["read", "grep"], sessionDir: "/tmp/sessions" });
		assert.equal(args[args.indexOf("--tools") + 1], "read,grep,agent_send,agent_stop,agent_spawn");
	});
});
