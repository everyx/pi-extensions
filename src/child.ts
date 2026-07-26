/**
 * pi-subagent — child mode.
 *
 * Activated by the env var `PI_SUBAGENT_PARENT_SOCKET` (set by the parent
 * tmux launcher script). It hooks `agent_settled` (and `agent_end` as a
 * fallback) to report assistant text back to the parent via the
 * length‑prefixed socket protocol.
 *
 * We track `_lastReportedLength` (number of branch entries at last send)
 * so each new turn / battle prompt triggers exactly one report, even when
 * both `agent_end` and `agent_settled` fire for the same turn. A sentinel
 * empty string is sent if no text was produced at all, so the parent never
 * hangs on socket wait.
 */

import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeLengthPrefixed } from "./protocol.js";
import { lastAssistantText } from "./utils.js";

let _lastReportedLength = 0;
let _socketPath: string;
let _sessionName: string;

/**
 * Install child‑mode handlers. Called once from the extension default export
 * when `PI_SUBAGENT_PARENT_SOCKET` is set.
 */
export function activateChildMode(pi: ExtensionAPI, socketPath: string, sessionName: string): void {
	_socketPath = socketPath;
	_sessionName = sessionName;

	const report = async (_event: unknown, ctx: ExtensionContext) => {
		const entries = ctx.sessionManager.getBranch();
		if (entries.length <= _lastReportedLength) return; // no new turn
		const text = lastAssistantText(ctx);
		_lastReportedLength = entries.length;

		try {
			const socket = net.createConnection(_socketPath);
			await new Promise<void>((resolve, reject) => {
				socket.on("connect", resolve);
				socket.on("error", reject);
			});
			// Send empty string sentinel if nothing produced → parent can close cleanly.
			await writeLengthPrefixed(socket, _sessionName, text || "");
			socket.end();
		} catch {
			/* best effort */
		}
	};

	pi.on("agent_end", report);
	pi.on("agent_settled", report);
}
