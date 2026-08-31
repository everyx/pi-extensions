/**
 * expandHintText — the expand-hint contract for header-only folded cards
 * (pi-ui single source; consumed by pi-web-tools).
 *
 * The judge is "the card has expandable content" — folding hides every byte,
 * truncated or not — not the LLM-visible truncation bit. The bound branch is
 * exercised hermetically by swapping the global keybinding table (pi-tui
 * setKeybindings) — restored after every test.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { expandHintText } from "../view.js";

function withExpandBinding() {
	const original = getKeybindings();
	setKeybindings(
		new KeybindingsManager(
			{ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool result" } },
			{ "app.tools.expand": "ctrl+o" },
		),
	);
	return () => setKeybindings(original);
}

afterEach(() => {
	// Guard: never leak a custom table into other tests.
	if (getKeybindings().getKeys("app.tools.expand").length) {
		throw new Error("expand-hint tests must restore the global keybinding table");
	}
});

describe("expandHintText", () => {
	it("no hint when the card has no content to expand", () => {
		assert.equal(expandHintText(undefined), "");
		assert.equal(expandHintText({}), "");
		assert.equal(expandHintText({ content: "" }), "");
	});

	it("no hint when the binding is unbound — nothing promised", () => {
		assert.equal(expandHintText({ content: "full text" }), "");
		assert.equal(expandHintText({ content: "x", fullContent: "x" }), "");
		assert.equal(expandHintText({ content: "cut", fullContent: "x", outputPath: "/tmp/x.txt" }), "");
	});

	it("renders the meta-parenthesis hint whenever content exists — truncated or not", () => {
		const restore = withExpandBinding();
		try {
			// small page: content, no truncation bit — the folded card still hides it
			assert.equal(expandHintText({ content: "full text" }), "ctrl+o to expand");
			// truncated page: same hint, truncation fields are extra data not the gate
			assert.equal(
				expandHintText({ content: "cut", fullContent: "x".repeat(99), outputPath: "/tmp/x.txt" }),
				"ctrl+o to expand",
			);
			// fullContent-only card
			assert.equal(expandHintText({ fullContent: "x" }), "ctrl+o to expand");
		} finally {
			restore();
		}
	});
});
