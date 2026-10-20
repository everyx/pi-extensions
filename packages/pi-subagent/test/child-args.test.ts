import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildArgs } from "../agent-process.js";

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
		assert.deepEqual(args, ["--model", "p/m", "--thinking", "high", "--tools", "read,grep", "--name", "probe"]);
	});

	it("caps the label so a long title cannot overflow --name", () => {
		const args = buildChildArgs({ label: "x".repeat(200) });
		const name = args[args.indexOf("--name") + 1];
		assert.equal(name?.length, 80);
	});
});
