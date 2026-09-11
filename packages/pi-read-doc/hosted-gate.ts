/**
 * The hosted gate: when to stop asking Firecrawl Parse, and why.
 *
 * Not a usage estimate (counting pages we believe we spent was a fiction: the
 * request uploads the whole document). It reacts to what the service actually
 * said and parks hosted until asking again makes sense. The state is a
 * user-level file, so it lives beside its own reader/writer and its own
 * reasons-to-change rather than inside the conversion chain.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Why hosted OCR is parked, and until when. */
export interface HostedSkip {
	until: number;
	reason: string;
}

/** The hosted gate: a reaction to the service, not a usage estimate. */
export interface HostedGate {
	/** Non-null while hosted should not be attempted. */
	skipped(now: Date): Promise<HostedSkip | null>;
	/** Remember a quota condition the service reported. */
	record(skip: HostedSkip): Promise<void>;
}

// ── The hosted gate (~/.pi/read-doc.json) ─────────────────────

// User-scoped extension state lives at the pi config root (~/.pi/), not inside
// pi's managed agent dir: it is a user-level record, and we deliberately do NOT
// follow PI_CODING_AGENT_DIR (an agent dir may point at sandbox/tmp — state
// should not wander). CONFIG_DIR_NAME honors a custom configDir.
function gatePath(): string {
	return join(homedir(), CONFIG_DIR_NAME, "read-doc.json");
}

/** Start of the next local day (the keyless cap is per IP per DAY). */
function startOfNextDay(now: Date): number {
	const next = new Date(now);
	next.setHours(24, 0, 0, 0);
	return next.getTime();
}

/** Start of the next local month (plan credits do not come back inside one). */
function startOfNextMonth(now: Date): number {
	return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

/**
 * Which quota condition a hosted failure names, and when to ask again.
 *
 * Firecrawl's documented semantics: 402 = plan credits exhausted (they do not
 * return inside the month); a keyless 429 = the free tier's per-IP daily cap
 * (it resets tomorrow); a keyed 429 = a per-minute rate limit, which must not
 * park hosted at all. anydoc spells the condition out because it knows the
 * status; the status itself is not exposed, so the message is all we have —
 * and a reworded message costs us the optimization, never correct behaviour.
 */
export function hostedExhaustion(message: string, now: Date): HostedSkip | null {
	if (/out of credits/i.test(message)) {
		return { until: startOfNextMonth(now), reason: "Firecrawl Parse credits exhausted" };
	}
	if (/keyless limit reached/i.test(message)) {
		return { until: startOfNextDay(now), reason: "Firecrawl Parse keyless daily limit reached" };
	}
	return null;
}

/** An API key the service rejected — not a quota, so nothing is parked, but
 *  the user should hear about it (a silent fallback to local OCR would hide a
 *  broken key). */
export function hostedKeyRejected(message: string): boolean {
	return /rejected the API key/i.test(message);
}

async function readGate(): Promise<{ until: number; reason: string } | null> {
	try {
		const raw = await readFile(gatePath(), "utf-8");
		const j = JSON.parse(raw) as { hosted?: { skipUntil?: string; reason?: string } };
		const until = Date.parse(j.hosted?.skipUntil ?? "");
		if (!Number.isFinite(until)) return null;
		return { until, reason: j.hosted?.reason ?? "hosted OCR paused" };
	} catch {
		return null; // absent or unreadable: not parked
	}
}

export const fileHostedGate: HostedGate = {
	async skipped(now: Date): Promise<HostedSkip | null> {
		const parked = await readGate();
		return parked && parked.until > now.getTime() ? parked : null;
	},
	async record(skip: HostedSkip): Promise<void> {
		try {
			const path = gatePath();
			await mkdir(dirname(path), { recursive: true });
			await writeFile(
				path,
				JSON.stringify({ hosted: { skipUntil: new Date(skip.until).toISOString(), reason: skip.reason } }, null, 2),
				"utf-8",
			);
		} catch {
			/* best-effort: a failed write must never break the read */
		}
	},
};
