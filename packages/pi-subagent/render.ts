/**
 * pi-subagent — notification card renderer.
 *
 * Background-agent completion notifications (registerMessageRenderer) —
 * the only surface still rendered directly: it's a custom message, not a
 * tool result, so it doesn't go through createToolView.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type CardIcon, type Component, errorIcon, stoppedIcon, successIcon } from "@everyx/pi-ui/card.js";
import { formatDuration } from "@everyx/pi-ui/spinner.js";
import { type CardBody, renderNoDetailsCard, renderNotificationCard } from "./card.js";
import type { NotificationDetails } from "./types.js";

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

/** Background-agent completion card: ✓/✗/■ + status word + usage meta. */
export function renderNotification(
	message: { details?: NotificationDetails },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Component {
	const d = message.details;

	if (!d) {
		return renderNoDetailsCard(theme);
	}

	const isError = d.status !== "completed";
	const icon: CardIcon = d.status === "completed" ? successIcon : d.status === "failed" ? errorIcon : stoppedIcon;
	const status =
		d.status === "failed"
			? { text: d.status, color: "error" as const }
			: d.status === "stopped"
				? { text: d.status, color: "warning" as const }
				: undefined;

	const metaParts: string[] = [];
	if (d.model) metaParts.push(d.model);
	if (d.thinking) metaParts.push(d.thinking);
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);
	// Persistent agent completed: resident (idle) — muted marker in the meta.
	if (d.idle) metaParts.push("idle");

	// Result text rides pi-ui's message channel (folded block, toolOutput color).
	// The old events channel died with pi-subagent's own renderCard — pi-ui's
	// renderCardUi only renders extra/error/message.
	const body: CardBody = d.result?.trim() ? { message: d.result.trim() } : {};

	return renderNotificationCard(
		{
			header: { icon, name: "agent_spawn", title: d.title, tail: status, meta: metaParts },
			body,
			footer: d.sessionPath,
			expanded,
		},
		theme,
		isError ? "error" : "success",
	);
}
