/**
 * pi-subagent — notification card layer.
 *
 * Background-agent completion notifications (registerMessageRenderer) — the
 * only surface rendered directly: it is a custom message, not a tool result,
 * so it does not go through createToolView (tool cards live in views.ts).
 * These wrappers add the notification's own background shell via pi-ui.
 *
 * The shell is pi's custom-message background, not a tool box: registering a
 * renderer means pi hands styling to us (custom-message.js: the renderer
 * "handles its own styling"), and a notification is a message — pi gives
 * customMessageBg to every non-tool block it renders itself ([compaction],
 * [branch], [skill], and any renderer-less sendMessage). Status rides the
 * icon and the status word, not the shell, exactly like pi's own fallback.
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

/** Notification card: the shared card grammar inside the message shell. */
export function renderNotificationCard(config: CardConfig, theme: Theme): BodyComponent {
	return cardShell(theme, "customMessageBg", renderCardUi(config, theme));
}

/** Notification fallback when no details arrived — dim one-liner, same shell. */
export function renderNoDetailsCard(theme: Theme): BodyComponent {
	return cardShell(theme, "customMessageBg", contentRow(theme.fg("dim", "(no details)")));
}
