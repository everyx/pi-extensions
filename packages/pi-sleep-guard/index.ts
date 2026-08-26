/**
 * pi-sleep-guard — block system sleep while this pi process's agent runs.
 *
 * Installed globally, one instance lives in every pi process (the main
 * interactive/RPC/print process and every `pi --mode rpc` sub-agent child).
 * Each instance holds its own platform sleep inhibitor exactly while its
 * own agent is running; the OS ORs the holders, so the machine stays awake
 * until every agent — main or sub-agent, foreground or background — has
 * settled. No cross-process contract needed.
 *
 * Semantics:
 *   agent_start   → acquire (covers tool execution between turns too)
 *   agent_settled → release  (fires only when no retry/compaction/queued
 *                            continuation remains — the exact "all turns done")
 *   session_shutdown → release (belt & suspenders)
 *
 * Honest boundaries (documented in README):
 *   - User-initiated sleep (lid close, power button, sleep menu) overrides
 *     any inhibitor on all three platforms — by OS design.
 *   - Platforms/backends with no inhibitor binary degrade to a one-time
 *     warning + no-op (能力缺失不静默), never blocking the agent itself.
 *
 * Config: PI_SLEEP_GUARD_DISPLAY=1 additionally blocks display off
 * (default: system sleep only, screen may blank normally).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WakeLock } from "./wake-lock.js";

export default function (pi: ExtensionAPI) {
	// Captured from the first event that carries a UI context, so the
	// lock's once-only failure notice reaches the user's channel (TUI/RPC)
	// instead of raw stderr — one channel, one warning, per process.
	let ui: { notify(message: string, type?: "info" | "warning" | "error"): void } | null = null;
	const lock = new WakeLock(process.platform, {
		display: process.env.PI_SLEEP_GUARD_DISPLAY === "1",
		warn: (failure) => {
			const detail =
				failure.reason === "no-backend"
					? `no sleep blocker for ${failure.platform}`
					: `sleep blocker unavailable (${failure.detail})`;
			if (ui) ui.notify(`pi-sleep-guard: ${detail}`, "warning");
			else console.error(`pi-sleep-guard: ${detail}; continuing without it`);
		},
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI) ui = ctx.ui;
		lock.acquire();
	});
	pi.on("agent_settled", async () => lock.release());
	pi.on("session_shutdown", async () => lock.release());
}
