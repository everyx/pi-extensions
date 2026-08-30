/**
 * pi-subagent — notification card layer.
 *
 * Background-agent completion notifications (registerMessageRenderer) — the
 * only surface rendered directly: it is a custom message, not a tool result,
 * so it does not go through createToolView (tool cards live in views.ts).
 * These wrappers add the notification's own background shell via pi-ui.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type BodyComponent,
	type CardConfig,
	cardShell,
	contentRow,
	renderCard as renderCardUi,
} from "@everyx/pi-ui/card.js";

export type { CardBody } from "@everyx/pi-ui/card.js";

/** Notification card: tool-style card inside a tinted background shell. */
export function renderNotificationCard(config: CardConfig, theme: Theme, bg: "error" | "success"): BodyComponent {
	return cardShell(theme, bg === "error" ? "toolErrorBg" : "toolSuccessBg", renderCardUi(config, theme));
}

/** Notification fallback when no details arrived — dim one-liner in an error shell. */
export function renderNoDetailsCard(theme: Theme): BodyComponent {
	return cardShell(theme, "toolErrorBg", contentRow(theme.fg("dim", "(no details)")));
}
