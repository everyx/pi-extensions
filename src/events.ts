/**
 * pi-subagent — parse `pi --print --mode json` event stream.
 *
 * The child pi emits one JSON object per line (`--mode json`). We turn the
 * raw byte stream into a typed event generator so the runner stays dumb.
 *
 * Events we care about:
 *   - text_delta   → incremental assistant text (for streaming)
 *   - agent_end     → final assistant message text (authoritative), or error if stopReason="error"
 *   - agent_settled → ignored here (parent side uses it; print runner just exits)
 *
 * Anything unparseable is silently dropped — matches `pi --print` semantics.
 */

export type PrintEvent =
	| { kind: "delta"; text: string }
	| { kind: "final"; text: string }
	| { kind: "error"; message: string }
	| { kind: "done" };

/** Decode a single JSON line into a PrintEvent, or null if uninteresting/unparseable. */
export function parsePrintLine(line: string): PrintEvent | null {
	if (!line.trim()) return null;
	let evt: Record<string, unknown>;
	try {
		evt = JSON.parse(line);
	} catch {
		return null;
	}

	// Safe: JSON.parse always produces an object with string keys; we only compare to known constants.
	const type = evt.type as string;

	if (type === "message_update") {
		const ae = evt.assistantMessageEvent as Record<string, unknown> | undefined;
		if (ae?.type === "text_delta" && typeof ae.delta === "string") {
			// Safe: guarded by `typeof ae.delta === "string"` above.
			return { kind: "delta", text: ae.delta as string };
		}
		return null;
	}

	if (type === "agent_end") {
		// Safe: JSON.parse may produce unknown shapes; we immediately null-check below.
		const messages = evt.messages as Array<Record<string, unknown>> | undefined;
		if (!messages) return { kind: "done" };
		// Walk back to find the last assistant message.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role !== "assistant") continue;
			// Detect API error: stopReason === "error" with an errorMessage.
			// Safe: guarded by `msg?.role === "assistant"` above.
			if ((msg as Record<string, unknown>).stopReason === "error") {
				const errMsg = (msg as Record<string, unknown>).errorMessage;
				const message = typeof errMsg === "string" ? errMsg : "API error (no details)";
				return { kind: "error", message };
			}
			// Safe: we only access .content on a known-shaped object after role check.
			const parts = (msg.content as Array<Record<string, unknown>> | undefined) ?? [];
			const text = parts
				// Safe: we filter for c.type === "text" and typeof c.text === "string" first.
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text as string)
				.join("\n")
				.trim();
			if (text) return { kind: "final", text };
			break;
		}
		return { kind: "done" };
	}

	return null;
}

/**
 * Convert a byte-stream callback API (`onData(buf)`) into an async generator
 * of complete lines. Handles partial-line buffering across chunks.
 *
 * `push(chunk)` feeds bytes; `close()` signals EOF (flushes trailing partial line).
 */
export function streamToLines(): {
	push: (chunk: Buffer | string) => void;
	close: () => void;
	lines: AsyncIterable<string>;
} {
	const queue: string[] = [];
	let leftover = "";
	let resolveWait: (() => void) | null = null;
	let ended = false;

	function wake() {
		const r = resolveWait;
		resolveWait = null;
		r?.();
	}

	function push(chunk: Buffer | string) {
		if (ended) return;
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const parts = (leftover + text).split("\n");
		leftover = parts.pop() ?? "";
		for (const line of parts) queue.push(line);
		wake();
	}

	function close() {
		ended = true;
		if (leftover) {
			queue.push(leftover);
			leftover = "";
		}
		wake();
	}

	async function* lines() {
		while (true) {
			while (queue.length === 0) {
				if (ended) return;
				await new Promise<void>((resolve) => (resolveWait = resolve));
			}
			const line = queue.shift();
			if (line !== undefined) yield line;
		}
	}

	return { push, close, lines: lines() };
}
