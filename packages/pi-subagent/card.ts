/**
 * pi-subagent — card component layer.
 *
 * The Card is the shared visual shell for every surface: a header row
 * (status icon + `Agent "title"` + optional state word / muted meta), an
 * optional body (prompt + activity stream / failure reason / steer message,
 * uniformly folded), and an optional footer (session path). Tool results
 * return `renderCard` directly — the framework's default-shell Box paints
 * the background; the notification card wraps it in its own shell
 * (`renderNotificationCard`), because the message renderer renders outside
 * the tool shell.
 *
 * Components follow Pi's own TUI organization: small self-contained
 * renderers fed by plain config objects (like pi-tui's Box / Container),
 * with the Spinner instance owned by the caller so animation state lives
 * with the render loop, not inside the card.
 */

import { homedir } from "node:os";
import { sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type BodyComponent,
	type Component,
	cardShell,
	contentRow,
	foldedBlock,
	renderCard as renderCardUi,
	type CardBody as UiCardBody,
	type CardConfig as UiCardConfig,
} from "@everyx/pi-ui/card.js";
import type { RenderEvent } from "./types.js";

// ─── Card config types ─────────────────────────────────────

/** pi-ui CardBody + the agent-specific activity stream fields. */
export interface CardBody extends UiCardBody {
	/** Prompt + activity stream (foreground tool card). */
	prompt?: string;
	events?: RenderEvent[];
}

/** pi-ui CardConfig with the extended body. */
export interface CardConfig extends UiCardConfig {
	body?: CardBody;
}

// ─── Internal building blocks ──────────────────────────────

/** Output preview line limit when collapsed. */

/** Expand `~`-style home prefix to a display path (cross-platform). */
function shortenHome(p: string): string {
	// `~` is not understood by Windows terminals (cmd/PowerShell) — keep the
	// full path there so the printed path stays copy-paste runnable.
	if (process.platform === "win32") return p;
	const home = homedir();
	if (p === home) return "~";
	return p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * Content row below a header/footer: a leading blank line separates it
 * (bash card parity). Must be a literal `\n` inside the text — an empty
 * Text (Text("")/Text("\n")) renders ZERO lines in pi-tui, so a bare gap
 * would vanish; `\n` + content renders "blank line + content".
 */

/**
 * Card background shell — Box(1, 1): 1-space horizontal padding, 1 row of
 * vertical padding top and bottom (like the framework's tool shell, so
 * notification cards match tool cards exactly). Only the notification card
 * needs it (registerMessageRenderer renders outside the tool shell); tool
 * cards get their background from the framework's default-shell Box instead
 * and must NOT wrap in card(). The blank rows are the shell's own padding —
 * content starts directly below the top padding row.
 */

/**
 * Unified card CONTENT (no background): optional header row + optional body
 * sections + optional session footer, assembled in order. Shared by every
 * card — tool results return it directly (the framework's default-shell Box
 * paints the background across header + body + footer); the notification
 * card wraps it in card() to paint its own. Headers start at the card edge
 * (the shell's padding row precedes them); body/footer sections carry their
 * own blank-line prefix so sections read header / blank / body / blank /
 * footer. Fold/blank-line/footer behavior lives here once, so every card
 * changes together.
 */

/** Shared `Agent "title"` segment — toolTitle bold name + bashMode quoted title. */

/**
 * One header row: `[marker] Agent "title" <state word / status> (<meta>)`.
 * The state is a natural-language verb phrase joined with a plain space —
 * `·` is reserved for data separators (widget elapsed time, notification
 * meta). The marker is a status icon (accent spinner / ✓ / ✗ / ■) so the
 * state reads at a glance; the quoted title uses bashMode like the bash
 * card's `$ cmd`, the `Agent` name keeps toolTitle bold.
 */
export /** Card content block with uniform folding: short content renders in full
 * (blank line + content); content past PREVIEW_LINES folds to a tail preview
 * with the expand hint (Ctrl+O to expand reveals everything — folding never
 * loses content, it only caps how much fills the screen). Shared by every
 * card body so the fold behavior is identical across surfaces. */

/** foldedBlock over a single colored string (split per line so colors survive folding). */

/**
 * Content block that honors the expanded flag: collapsed uses the uniform
 * fold (tail preview + expand hint); expanded renders every line in full
 * (blank-line prefix preserved in both modes — bash card parity). Content is
 * never dropped in either mode.
 */

/** Style one body row per its kind (pi-native colors). */
function styleRow(row: { style: "prompt" | "thinking" | "tool" | "text"; content: string }, theme: Theme): string {
	switch (row.style) {
		case "thinking":
			return theme.italic(theme.fg("thinkingText", row.content));
		case "tool": {
			const sepIdx = row.content.indexOf(":");
			if (sepIdx === -1) return theme.fg("toolTitle", row.content);
			return `${theme.fg("toolTitle", row.content.slice(0, sepIdx))}${theme.fg("muted", row.content.slice(sepIdx))}`;
		}
		default:
			return theme.fg("toolOutput", row.content);
	}
}

/**
 * Flatten prompt + events into styled rows with pi-parity block spacing:
 * each activity block (thinking run, individual tool call, text run) is
 * separated from the next by a blank row — pi's assistant message uses
 * Spacer(1) between thinking/text and each tool execution card carries its
 * own top spacer, so blocks never touch. Text rows inside one run stay
 * tight (a streamed chunk may split across events). Leading/trailing blank
 * rows are trimmed — bash.js parity: the result card trims the whole
 * output (`output.trim()`), so only head/tail padding goes; blank
 * separators *inside* the stream (the prompt divider, markdown paragraph
 * gaps) survive. Trim happens here so collapsed and expanded render the
 * same stream.
 */
function bodyRows(
	input: string | undefined,
	events: RenderEvent[] | undefined,
): { style: "prompt" | "thinking" | "tool" | "text"; content: string }[] {
	const rows: { style: "prompt" | "thinking" | "tool" | "text"; content: string }[] = [];
	/** Blank separator row — only ever inserted at a block boundary. */
	const pushSeparator = () => {
		const last = rows[rows.length - 1];
		if (last && last.content !== "") rows.push({ style: "text", content: "" });
	};
	/** Start a block: separated from a preceding different block (a text row
	 * continuing a text run is not a block boundary). */
	const pushBlock = (style: "prompt" | "thinking" | "tool" | "text", content: string) => {
		const last = rows[rows.length - 1];
		const continuesText = style === "text" && last?.style === "text";
		if (last && !continuesText) pushSeparator();
		rows.push({ style, content });
	};

	const promptText = input?.trim();
	if (promptText) pushBlock("prompt", promptText);

	for (const ev of events ?? []) {
		if (ev.kind === "thinking") {
			pushBlock("thinking", "Thinking...");
		} else if (ev.kind === "tool") {
			pushBlock("tool", `${ev.name}:${ev.args ? ` ${ev.args}` : ""}`);
		} else {
			// A text event may split across streamed chunks — the first line
			// opens the run (separated from the previous block), the rest join
			// it tight.
			const lines = ev.text.split("\n");
			lines.forEach((line, i) => {
				if (i === 0) pushBlock("text", line);
				else rows.push({ style: "text", content: line });
			});
		}
	}
	// Drop blank (zero-length or whitespace-only) head/tail rows — bash.js
	// trims the whole output (`output.trim()`), which likewise drops trailing
	// blank lines; interior blank separators survive. Bash's trim would also
	// strip horizontal padding off the first/last content line, which we
	// deliberately keep (code-fence indentation must survive).
	const isBlank = (c: string) => c.trim() === "";
	// Two-pointer scan trims head/tail blanks in O(n); shift()/pop() on the
	// head would be O(n²). `first <= last` also covers the all-blank case.
	let first = 0;
	let last = rows.length - 1;
	while (first < rows.length && isBlank(rows[first].content)) first++;
	while (last >= 0 && isBlank(rows[last].content)) last--;
	return first <= last ? rows.slice(first, last + 1) : [];
}

/**
 * Shared output body: the prompt and the sub-agent's activity stream are one
 * stream — the prompt rides at the head and flows away as output grows
 * (terminal-scroll feel; the header title is the card's fixed identifier).
 * Events render in order with their pi-native styles (Thinking... italic,
 * tool calls toolTitle, text in toolOutput). Collapsed folds the stream to
 * the tail PREVIEW_LINES with an "N earlier lines" hint; expanded shows
 * everything. Returns null when there is nothing to show.
 */
function renderBody(body: CardBody, expanded: boolean, theme: Theme): BodyComponent | null {
	const rows = bodyRows(body.prompt, body.events);
	if (rows.length === 0) return null;

	if (expanded) {
		const cmp = new Container();
		// First row carries the blank-line prefix (blank + content).
		cmp.addChild(contentRow(styleRow(rows[0], theme)));
		for (const row of rows.slice(1)) {
			// Block separators are real blank rows — pi-tui's Text renders zero
			// lines for empty content, so a Spacer is the only way to draw the
			// pi-parity gap between activity blocks.
			if (row.content === "") cmp.addChild(new Spacer(1));
			else cmp.addChild(new Text(styleRow(row, theme), 0, 0));
		}
		return cmp;
	}

	// Collapsed: uniform fold — short content in full, long content tail-5
	// preview + expand hint (same foldedBlock as every other card).
	return foldedBlock(
		rows.map((r) => styleRow(r, theme)),
		theme,
	);
}

// ─── Card components ───────────────────────────────────────

/**
 * Assemble a full card (no background shell): header row + optional body
 * sections (activity stream, failure reason, steer message) + optional
 * session footer. Tool results return this directly — the framework's
 * default-shell Box paints the background.
 */
/**
 * Assemble a full card: header + body sections (activity stream, failure
 * reason, steer message) + session footer — via pi-ui renderCard (folding
 * built in); the agent activity stream rides body.extra.
 */
export function renderCard(config: CardConfig, theme: Theme): Component {
	const b = config.body;
	const extra: BodyComponent[] = [];
	if (b && (b.prompt !== undefined || b.events?.length)) {
		const stream = renderBody(b, config.expanded, theme);
		if (stream) extra.push(stream);
	}
	return renderCardUi(
		{
			...config,
			footer: config.footer ? `session: ${shortenHome(config.footer)}` : undefined,
			body: b ? { error: b.error, message: b.message, extra: [...(b.extra ?? []), ...extra] } : undefined,
		},
		theme,
	);
}

export function renderNotificationCard(config: CardConfig, theme: Theme, bg: "error" | "success"): Component {
	return cardShell(theme, bg === "error" ? "toolErrorBg" : "toolSuccessBg", renderCardUi(config, theme));
}

/** Notification fallback when no details arrived — dim one-liner in an error shell. */
export function renderNoDetailsCard(theme: Theme): Component {
	return cardShell(theme, "toolErrorBg", contentRow(theme.fg("dim", "(no details)")));
}
