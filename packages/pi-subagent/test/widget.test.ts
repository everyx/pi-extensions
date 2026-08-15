import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { activityToRows } from "../widget.js";

describe("activityToRows — widget line width safety", () => {
	it("keeps short tool args intact", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "ls -la" });
		assert.deepEqual(rows, [{ style: "tool", content: "bash: ls -la" }]);
	});

	it("caps long tool args so the widget line stays bounded", () => {
		const rows = activityToRows({ kind: "tool", name: "write", args: "x".repeat(5000) });
		const content = rows[0]?.content ?? "";
		assert.ok(content.startsWith("write: "));
		assert.ok(content.length <= "write: ".length + 80, `content too long: ${content.length}`);
	});

	it("caps CJK tool args by terminal width, not char count", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "调研亮色高亮色处理方案".repeat(30) });
		const content = rows[0]?.content ?? "";
		// 4-space widget indent + content must fit a 163-col terminal
		assert.ok(4 + visibleWidth(content) <= 163, `widget line width ${4 + visibleWidth(content)} > 163`);
	});

	it("flattens multi-line tool args (heredoc payloads) to a single line", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "cat > /tmp/x.py << 'EOF'\nimport colorsys\nEOF" });
		const content = rows[0]?.content ?? "";
		assert.ok(!content.includes("\n"), "newlines must be flattened");
		assert.match(content, /import colorsys/);
	});

	it("caps text activity too", () => {
		const rows = activityToRows({ kind: "text", text: "y".repeat(1000) });
		const content = rows[0]?.content ?? "";
		assert.ok(content.length <= 80);
	});
});
