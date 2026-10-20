/**
 * The LLM-visible copy budget — a ratchet, not a style guide.
 *
 * Every string in copy.ts is paid for on every request, so growth has to be a
 * decision someone makes on purpose. Measuring "is this line necessary" is a
 * judgement no test can make; measuring "did the total grow" is mechanical,
 * and growth is the first symptom of the bloat that judgement is meant to
 * catch.
 *
 * When a change here is intentional, raise the number in the same commit —
 * the number moving is the review hook.
 *
 * The other assertions are not budgets but invariants, and they fail for
 * reasons the model would feel:
 *
 *   - a tool without a snippet is not listed in the system prompt at all
 *     (pi filters the tool list by snippet presence), so it becomes
 *     effectively invisible;
 *   - pi de-duplicates identical guidelines across tools, so a repeated one
 *     is paid for and then dropped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_COPY } from "../copy.js";

/** Total characters of description + snippet + guidelines + parameter
 *  descriptions. Measured, not aspirational: 2,209 when the layering was
 *  introduced (down from 3,256 unstructured). */
const CHAR_BUDGET = 2_300;

/** Guidelines survive only if the model would still get them wrong after
 *  seeing the snippet, the description and one real result. */
const GUIDELINE_BUDGET = 7;

const entries = Object.entries(TOOL_COPY);

const copyChars = (tool: (typeof entries)[number][1]): number =>
	tool.description.length +
	tool.snippet.length +
	tool.guidelines.join("").length +
	Object.values(tool.paramDescriptions).join("").length;

describe("LLM copy — shape", () => {
	it("every tool has a snippet: without one it is missing from the tool list", () => {
		for (const [name, tool] of entries) {
			assert.ok(tool.snippet.trim().length > 0, `${name} has no promptSnippet`);
		}
	});

	it("every guideline is a rule, not a paragraph", () => {
		for (const [name, tool] of entries) {
			for (const rule of tool.guidelines) {
				assert.ok(rule.trim().length > 0, `${name} has an empty guideline`);
				assert.ok(rule.length <= 200, `${name} guideline is ${rule.length} chars — split it or cut it: ${rule}`);
			}
		}
	});

	it("no guideline is duplicated across tools (pi de-duplicates, so the copy is wasted)", () => {
		const seen = new Map<string, string>();
		for (const [name, tool] of entries) {
			for (const rule of tool.guidelines) {
				const prior = seen.get(rule);
				assert.equal(prior, undefined, `"${rule}" appears in both ${prior} and ${name}`);
				seen.set(rule, name);
			}
		}
	});
});

describe("LLM copy — budget", () => {
	it(`total stays under ${CHAR_BUDGET} characters`, () => {
		const total = entries.reduce((sum, [, tool]) => sum + copyChars(tool), 0);
		assert.ok(
			total <= CHAR_BUDGET,
			`LLM copy is ${total} chars, budget ${CHAR_BUDGET}. Cutting is the default; if the growth is right, raise the budget in this commit.`,
		);
	});

	it(`guidelines stay under ${GUIDELINE_BUDGET} (one out, one in)`, () => {
		const total = entries.reduce((sum, [, tool]) => sum + tool.guidelines.length, 0);
		assert.ok(total <= GUIDELINE_BUDGET, `${total} guidelines, budget ${GUIDELINE_BUDGET}`);
	});

	it("a parameter description is only there when the name does not say it", () => {
		// The self-evident ones: `prompt`, `label`, `message`. Keeping a
		// description for these costs tokens every request and teaches nothing.
		for (const name of ["prompt", "label", "message"]) {
			for (const [tool, copy] of entries) {
				const params: Record<string, string> = copy.paramDescriptions;
				assert.equal(params[name], undefined, `${tool}.${name} has a description — the name already says it`);
			}
		}
	});
});
