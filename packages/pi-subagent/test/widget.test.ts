import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityToRows } from "../widget.js";

describe("activityToRows — pure data (width clipping lives in the widget render layer)", () => {
	it("maps short tool args to one tool row", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "ls -la" });
		assert.deepEqual(rows, [{ style: "tool", content: "bash: ls -la" }]);
	});

	it("does not truncate long args (render layer clips to terminal width)", () => {
		const rows = activityToRows({ kind: "tool", name: "write", args: "x".repeat(5000) });
		const content = rows[0]?.content ?? "";
		assert.equal(content, `write: ${"x".repeat(5000)}`);
	});

	it("flattens multi-line tool args (heredoc payloads) to a single line", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "cat > /tmp/x.py << 'EOF'\nimport colorsys\nEOF" });
		const content = rows[0]?.content ?? "";
		assert.ok(!content.includes("\n"), "newlines must be flattened");
		assert.match(content, /import colorsys/);
	});

	it("keeps streamed text as-is (no clipping at the data layer)", () => {
		const rows = activityToRows({ kind: "text", text: "y".repeat(1000) });
		assert.equal(rows[0]?.content, "y".repeat(1000));
	});
});
