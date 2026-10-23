/**
 * endingNote / withEnding — what a parent is told when its agent did not just
 * finish.
 *
 * A completion carries its answer. Every other ending is the child being cut
 * off from the outside, so it says nothing about it: the parent reads a bare
 * "stopped" or a silent failure, guesses, and spawns the task over — 30
 * minutes re-run by hand while a `resume` would have continued it (issue
 * #51, session 2026-10-23). Both halves of the copy are load-bearing: why it
 * ended, and that the run is still there to continue.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Ending, endingNote, withEnding } from "../agent-process.js";

const RESUMABLE = "Continue the same session with `resume`.";

const ending = (over: Partial<Ending>): Ending => ({
	status: "completed",
	hardAborted: false,
	exitCode: 0,
	...over,
});

describe("endingNote — the endings that cannot speak for themselves", () => {
	it("says nothing for a completion: the answer is the ending", () => {
		assert.equal(endingNote(ending({ status: "completed" })), undefined);
	});

	it("a deadline stop names the deadline, not just the stop", () => {
		assert.equal(
			endingNote(ending({ status: "stopped", hardAborted: true, timeoutMs: 1_800_000 })),
			`Stopped: the 1800000ms timeout expired. ${RESUMABLE}`,
		);
	});

	it("echoes the value the parent passed, in the unit it passed it in", () => {
		// The caller wrote `timeoutMs: 1_800_000` itself — any human form here
		// would be us translating a number both sides already agree on.
		const note = String(endingNote(ending({ status: "stopped", hardAborted: true, timeoutMs: 90_000 })));
		assert.match(note, /^Stopped: the 90000ms timeout expired\./);
	});

	it("a failure carries its cause, once", () => {
		assert.equal(
			endingNote(ending({ status: "failed", agentError: "API error (529): overloaded" })),
			`Failed: API error (529): overloaded. ${RESUMABLE}`,
		);
	});

	it("a cause that already ends in a period does not grow a second one", () => {
		assert.match(String(endingNote(ending({ status: "failed", agentError: "boom." }))), /^Failed: boom\. Continue/);
	});

	it("falls back to the exit code when nobody said why", () => {
		assert.equal(
			endingNote(ending({ status: "failed", exitCode: 1, stderr: "" })),
			`Failed: pi exited (code 1). ${RESUMABLE}`,
		);
	});

	it("prefers stderr over an exit code, skipping the stack that follows the cause", () => {
		const note = String(
			endingNote(
				ending({
					status: "failed",
					exitCode: 1,
					stderr:
						"Error: Cannot find module 'x'\n" +
						"    at Module._resolveFilename (node:internal/modules)\n" +
						"    at Module._load (node:internal)\n" +
						"    at ...",
				}),
			),
		);
		assert.match(note, /^Failed: Error: Cannot find module 'x'\./);
		assert.ok(!note.includes("at "), "the frames are not the cause");
	});

	it("keeps a CLI error that genuinely comes last", () => {
		const note = String(endingNote(ending({ status: "failed", stderr: "warning: slow\nFATAL: bad API key" })));
		assert.match(note, /^Failed: FATAL: bad API key\./);
	});

	it("falls back to the last frame when the trace is all there is", () => {
		const note = String(endingNote(ending({ status: "failed", stderr: "    at Module._load (node:internal)\n" })));
		assert.match(note, /^Failed: at Module\._load/);
	});

	it("caps a single monstrous line instead of flooding the parent's context", () => {
		const note = String(endingNote(ending({ status: "failed", agentError: "x".repeat(5_000) })));
		assert.ok(note.length < 300, `note is ${note.length} chars`);
	});

	it("still speaks for a stop with no deadline attached", () => {
		assert.equal(
			endingNote(ending({ status: "stopped", hardAborted: false })),
			`Stopped before it finished. ${RESUMABLE}`,
		);
	});
});

describe("withEnding — partial work stays readable", () => {
	it("keeps what the agent said, then says why it stopped", () => {
		assert.equal(withEnding("half a report", "Stopped: …"), "half a report\n\nStopped: …");
	});

	it("a silent child is just the reason", () => {
		assert.equal(withEnding("", "Stopped: …"), "Stopped: …");
		assert.equal(withEnding("  \n\t ", "Stopped: …"), "Stopped: …");
	});

	it("a natural ending passes through untouched", () => {
		assert.equal(withEnding("the answer\n", undefined), "the answer\n");
	});
});
