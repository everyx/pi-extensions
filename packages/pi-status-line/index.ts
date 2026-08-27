/**
 * pi-status-line — Pi-native status line: TPS + TTFT integrated into footer.
 *
 * Uses ctx.ui.setFooter to render TPS/TTFT inline with token stats on the
 * same line (↑↓ right after output), rather than setStatus which always
 * creates a separate third line. Layout 1:1 replicates official footer
 * (pwd + statsLeft + rightSide with padding, dim styling, width truncation).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTps, formatTtft, TurnMetrics } from "./tps.js";

export default function (pi: ExtensionAPI) {
	const metrics = new TurnMetrics();
	let tuiRef: { requestRender(): void } | null = null;

	// Install custom footer once at startup. Data comes from footerData
	// (branch, extensionStatuses) and ctx (model, context, usage).
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			return {
				invalidate() {},
				dispose: footerData.onBranchChange(() => tui.requestRender()),
				render(width: number): string[] {
					// --- pwd line (official logic) ---
					let pwd: string = ctx.sessionManager.getCwd();
					try {
						const r = resolve(pwd);
						const h = resolve(process.env.HOME || process.env.USERPROFILE || "");
						const rel = relative(h, r);
						const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
						if (inside) pwd = rel === "" ? "~" : `~${sep}${rel}`;
					} catch {}
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = (ctx.sessionManager as unknown as { getSessionName(): string | null }).getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// --- statsLeft: token counts + TPS/TTFT + context ---
					const entries: Array<{
						type: string;
						message?: { role: string; usage?: Record<string, number> };
						usage?: Record<string, number>;
					}> = (ctx.sessionManager as unknown as { getEntries(): typeof entries }).getEntries?.() ?? [];
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					let latestCacheHit: number | undefined;
					for (const e of entries) {
						if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
							const u = e.message.usage as Record<string, number>;
							input += u.input ?? 0;
							output += u.output ?? 0;
							cacheRead += u.cacheRead ?? 0;
							cacheWrite += u.cacheWrite ?? 0;
							cost += (u.cost as unknown as { total?: number })?.total ?? 0;
							const pt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
							if (pt > 0) latestCacheHit = ((u.cacheRead ?? 0) / pt) * 100;
						}
					}
					const ctxUsage = (
						ctx as unknown as { getContextUsage(): { percent: number | null; contextWindow: number } | null }
					).getContextUsage?.();
					const contextWindow =
						ctxUsage?.contextWindow ??
						(ctx as unknown as { model?: { contextWindow: number } }).model?.contextWindow ??
						0;
					const pct = ctxUsage?.percent ?? 0;

					// Mirrors Pi's footer.js:formatTokens — single space join is Pi Native
					const fmt = (n: number): string => {
						if (n < 1000) return String(n);
						if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
						if (n < 1000000) return `${Math.round(n / 1000)}k`;
						if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
						return `${Math.round(n / 1000000)}M`;
					};

					const parts: string[] = [];
					if (input) parts.push(`↑${fmt(input)}`);
					if (output) parts.push(`↓${fmt(output)}`);
					// TPS/TTFT right after output — same line, Pi Native
					const now = Date.now();
					const tps = metrics.liveTps(now);
					if (tps !== null) parts.push(formatTps(tps));
					const ttft = metrics.ttftMs;
					if (ttft !== null) parts.push(formatTtft(ttft));
					if (cacheRead) parts.push(`R${fmt(cacheRead)}`);
					if (cacheWrite) parts.push(`W${fmt(cacheWrite)}`);
					if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHit !== undefined)
						parts.push(`CH${latestCacheHit.toFixed(1)}%`);
					if (cost) parts.push(`$${cost.toFixed(3)}`);
					const auto = " (auto)";
					const ctxStr =
						ctxUsage?.percent !== null && ctxUsage?.percent !== undefined
							? `${pct.toFixed(1)}%/${fmt(contextWindow)}${auto}`
							: `?/${fmt(contextWindow)}${auto}`;
					let ctxDisplay = ctxStr;
					if (pct > 90) ctxDisplay = (theme as unknown as { fg(c: string, s: string): string }).fg("error", ctxStr);
					else if (pct > 70)
						ctxDisplay = (theme as unknown as { fg(c: string, s: string): string }).fg("warning", ctxStr);
					parts.push(ctxDisplay);

					let statsLeft = parts.join(" "); // Pi Native: single space, same as official statsParts.join(" ")

					if (visibleWidth(statsLeft) > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
					}
					const statsLeftW = visibleWidth(statsLeft);
					const modelId = (ctx as unknown as { model?: { id: string } }).model?.id ?? "no-model";
					const isReasoning = (ctx as unknown as { model?: { reasoning: boolean } }).model?.reasoning ?? false;
					const thinkingLevel = isReasoning ? "high" : "off";
					let rightSide = (ctx as unknown as { model?: { reasoning: boolean } }).model?.reasoning
						? thinkingLevel === "off"
							? `${modelId} • thinking off`
							: `${modelId} • ${thinkingLevel}`
						: modelId;
					const provider = (ctx as unknown as { model?: { provider: string } }).model?.provider;
					if (provider && footerData.getAvailableProviderCount() > 1) {
						const withProv = `(${provider}) ${rightSide}`;
						if (statsLeftW + 2 + visibleWidth(withProv) <= width) rightSide = withProv;
					}
					const rightW = visibleWidth(rightSide);
					let statsLine: string;
					const need = statsLeftW + 2 + rightW;
					if (need <= width) {
						const pad = " ".repeat(width - statsLeftW - rightW);
						statsLine = statsLeft + pad + rightSide;
					} else {
						const avail = width - statsLeftW - 2;
						if (avail > 0) {
							const tr = truncateToWidth(rightSide, avail, "");
							const pad = " ".repeat(Math.max(0, width - statsLeftW - visibleWidth(tr)));
							statsLine = statsLeft + pad + tr;
						} else statsLine = statsLeft;
					}
					const dim = (s: string) => (theme as unknown as { fg(c: string, s: string): string }).fg("dim", s);
					const pwdLine = truncateToWidth(dim(pwd), width, dim("..."));
					const leftPart = statsLine.slice(0, statsLeft.length);
					const remainder = statsLine.slice(statsLeft.length);
					const dimLine = dim(leftPart) + dim(remainder);
					return [pwdLine, dimLine];
				},
			};
		});
	});

	function requestRender(): void {
		tuiRef?.requestRender();
	}

	pi.on("turn_start", async () => {
		metrics.startTurn(Date.now());
		requestRender();
	});

	pi.on("message_update", async (event) => {
		const delta = extractDelta(event);
		if (!delta) return;
		metrics.addDelta(delta, Date.now());
		requestRender();
	});

	pi.on("message_end", async () => {
		requestRender();
	});

	pi.on("session_shutdown", async () => {
		metrics.clear();
	});
}

function extractDelta(event: unknown): string | null {
	if (!event || typeof event !== "object") return null;
	const e = event as Record<string, unknown>;
	const ame = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
	if (ame && typeof ame.delta === "string" && ame.delta.length > 0) {
		if (ame.type === "text_delta" || ame.type === "thinking_delta") return ame.delta;
		return ame.delta;
	}
	return null;
}
