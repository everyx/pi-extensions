/**
 * pi-subagent — tool card views (single source of truth).
 *
 * The three card templates (agent_spawn / agent_stop / agent_send) live here
 * so production (index.ts registration) and the dev preview (preview.ts)
 * render the exact same cards — no mirrored copies to drift.
 *
 * Pure rendering: no pi API, no registry — only the ToolRenderContext shape.
 */

import { durationMeta } from "@everyx/pi-ui/spinner.js";
import { createToolView } from "@everyx/pi-ui/view.js";

/**
 * Card title for agent_stop / agent_send: the target's human title when the
 * result carried one, else the target id from the result, else from args.
 */
export function titleFrom(ctx: { result?: { data?: unknown }; args?: unknown }, idKey: string): string {
	const data = (ctx.result?.data as ({ title?: string } & Record<string, unknown>) | undefined) ?? {};
	const args = ctx.args as Record<string, unknown> | undefined;
	return String(data.title ?? data[idKey] ?? args?.[idKey] ?? "").slice(0, 60);
}

export const spawnView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "agent_spawn",
	title: (ctx) => {
		const d = ctx.result?.data as { title?: string; task?: string } | undefined;
		return String((ctx.args as { title?: unknown }).title ?? d?.title ?? d?.task ?? "").slice(0, 60);
	},
	tail: (ctx) => {
		if (ctx.status === "error") return "start failed";
		if (ctx.status === "processing") {
			// starting… while nothing has streamed yet, working… once the
			// agent is actually producing activity.
			const d = ctx.result?.data as { events?: unknown[] } | undefined;
			return d?.events?.length ? "working\u2026" : "starting\u2026";
		}
		// Completed: "started" is a background spawn (task keeps running,
		// tracked by the widget); a foreground agent is simply done.
		const d = ctx.result?.data as { runInBackground?: boolean } | undefined;
		return d?.runInBackground ? "started" : "done";
	},
	meta: (ctx) => {
		const d = ctx.result?.data as
			| { model?: string; thinking?: string; startedAt?: number; endedAt?: number; runInBackground?: boolean }
			| undefined;
		const args = ctx.args as { model?: unknown; thinking?: unknown } | undefined;
		const parts: string[] = [];
		const model = d?.model ?? args?.model;
		if (model) parts.push(String(model));
		const thinking = d?.thinking ?? args?.thinking;
		if (thinking) parts.push(String(thinking));
		// Duration meta: live Elapsed while running (the call seeds startedAt
		// at execution start), fixed Took once the foreground task finished.
		// A background spawn leaves the task running — no duration (the widget
		// tracks it live).
		if (d?.startedAt != null) {
			if (!d.runInBackground) {
				const dur = durationMeta(ctx.status, d.startedAt, d.endedAt);
				if (dur) parts.push(dur);
			}
		}
		return parts;
	},
	body: {
		rows: {
			of: (ctx) => {
				const d = ctx.result?.data as { task?: string; events?: unknown[] } | undefined;
				// Mixed activity stream: the task (prompt) heads the flow, then
				// the sub-agent session events in order — both scroll out of
				// the fold as output grows (SPEC: prompt 在流头).
				const events = d?.events ?? [];
				return d?.task ? [{ kind: "prompt", text: d.task }, ...events] : events;
			},
			rows: [
				{
					content: (_ctx, ev) => {
						const e = ev as { kind: string; name?: string; args?: string; text?: string };
						if (e.kind === "prompt") return { style: "muted", content: e.text ?? "" };
						if (e.kind === "thinking") return { style: "thinking", content: "Thinking..." };
						if (e.kind === "tool") return { style: "tool", content: `${e.name ?? ""}: ${e.args ?? ""}` };
						return { style: "text", content: e.text ?? "" };
					},
				},
			],
		},
	},
	// Session footer: recoverable on the card, never into LLM context
	// (SPEC: footer 仅 session: <path>). Present on foreground completion;
	// background spawn cards carry no session yet.
	footer: (ctx) => (ctx.result?.data as { sessionPath?: string } | undefined)?.sessionPath,
});

export const stopView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "agent_stop",
	title: (ctx) => titleFrom(ctx, "agentId"),
	tail: (ctx) => {
		if (ctx.status === "error") return "stop failed";
		if (ctx.status === "processing") return "stopping\u2026";
		return "stopped";
	},
});

export const sendView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "agent_send",
	title: (ctx) => titleFrom(ctx, "to"),
	tail: (ctx) => {
		if (ctx.status === "error") return "failed";
		if (ctx.status === "processing") return "sending\u2026";
		return "delivered";
	},
	// The message body shows on the card (folded at 5 rows like bash).
	body: { text: (ctx) => (ctx.result?.data as { message?: string } | undefined)?.message ?? "" },
});
