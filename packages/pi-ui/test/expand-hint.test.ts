/**
 * expandHintText — the truncation→expand-hint contract for header-only
 * folded cards (pi-ui single source; consumed by pi-web-tools).
 *
 * The bound branch is exercised hermetically by swapping the global
 * keybinding table (pi-tui setKeybindings) — restored after every test.
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
	it("no hint when the data isn't truncated (no outputPath)", () => {
		assert.equal(expandHintText(undefined), "");
		assert.equal(expandHintText({ content: "full text" }), "");
		assert.equal(expandHintText({ content: "x", fullContent: "x" }), "", "fullContent alone is not the truncation bit");
	});

	it("no hint when the binding is unbound — nothing promised", () => {
		assert.equal(expandHintText({ outputPath: "/tmp/x.txt" }), "");
	});

	it("renders the live keybinding suffix when truncated and bound", () => {
		const restore = withExpandBinding();
		try {
			assert.match(expandHintText({ outputPath: "/tmp/x.txt" }), /^ \(.+ to expand\)$/);
			assert.ok(expandHintText({ outputPath: "/tmp/x.txt" }).includes("ctrl+o"), "default binding ctrl+o");
		} finally {
			restore();
		}
	});
});
