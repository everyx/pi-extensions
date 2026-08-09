/**
 * pi-subagent — shared formatting utilities.
 *
 * Pure string-formatting and display helpers used by the TUI rendering
 * layer (render.ts), the status widget (widget.ts), and the tool glue
 * (index.ts). Spinner/duration/clip/title helpers come from the shared
 * pi-ui package; activityRow is subagent-specific (AgentActivity shape).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { clipTail as _clipTail } from "@everyx/pi-ui/spinner.js";
import type { AgentActivity } from "./event-interpret.js";

export { clipTail, formatDuration, SPINNER, Spinner, safeTitle } from "@everyx/pi-ui/spinner.js";

const clipTail = _clipTail;

/**
 * One activity row: "Thinking..." (pi hidden-thinking style), a tool call
 * (toolTitle name + ": " + muted args), or muted text. Shared by the tool
 * card activity row and the Agents widget — single source of truth so the
 * two surfaces can never drift apart. Pass `max` to truncate long tails
 * (widget); the card passes none and shows the full text.
 */
export function activityRow(activity: AgentActivity, theme: Theme, max?: number): string {
	if (activity.kind === "thinking") {
		return theme.italic(theme.fg("thinkingText", "Thinking..."));
	}
	if (activity.kind === "tool") {
		const args = max === undefined ? activity.args : clipTail(activity.args, max);
		return args
			? `${theme.fg("toolTitle", activity.name)}: ${theme.fg("muted", args)}`
			: theme.fg("toolTitle", activity.name);
	}
	return theme.fg("muted", max === undefined ? activity.text : clipTail(activity.text, max));
}
