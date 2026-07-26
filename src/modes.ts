/**
 * pi-subagent — mode parsing.
 *
 * The `subagent` tool collapses three operations (print / interactive / battle
 * / close) into one schema. `parseMode` turns the raw params into a
 * discriminated union so `execute` and the renderers can `switch` on a clean
 * tag instead of re-validating boolean combinations everywhere.
 */

export interface SubagentParams {
	task?: string;
	model?: string;
	tools?: string[];
	interactive?: boolean;
	session?: string;
	close?: boolean;
}

export type Mode =
	| { kind: "print"; task: string; model?: string; tools?: string[] }
	| { kind: "interactive"; task: string; model?: string; tools?: string[] }
	| { kind: "battle"; session: string; task: string }
	| { kind: "close"; session: string }
	| { kind: "error"; message: string };

/**
 * Classify raw tool params into one of five modes.
 *
 * Rules (mutually exclusive):
 *   - close:       `session` + `close:true` (+ nothing else)
 *   - battle:      `session` + `task`     (+ no close)
 *   - print:       `task` alone            (interactive omitted / false)
 *   - interactive: `task` + interactive:true
 *
 * Anything else (incl. ambiguous overlaps) → `error` with a human message.
 */
export function parseMode(params: SubagentParams): Mode {
	const hasTask = !!params.task?.trim();
	const hasSession = !!params.session?.trim();
	const hasClose = !!params.close;

	// `close` forbids `task` outright.
	if (hasClose && hasTask) {
		return { kind: "error", message: "`close` cannot be combined with `task`." };
	}

	if (params.close) {
		if (!hasSession) return { kind: "error", message: "`close` requires a `session`." };
		return { kind: "close", session: (params.session as string).trim() };
	}

	if (hasSession && hasTask) {
		return {
			kind: "battle",
			session: (params.session as string).trim(),
			task: (params.task as string).trim(),
		};
	}

	if (hasSession && !hasTask && !hasClose) {
		return { kind: "error", message: "`session` requires either `task` (battle) or `close: true`." };
	}

	if (hasTask) {
		const task = (params.task as string).trim();
		if (params.interactive) {
			return { kind: "interactive", task, model: params.model, tools: params.tools };
		}
		return { kind: "print", task, model: params.model, tools: params.tools };
	}

	return {
		kind: "error",
		message: "Provide `task` (execute), `session` + `task` (battle), or `session` + `close`.",
	};
}
