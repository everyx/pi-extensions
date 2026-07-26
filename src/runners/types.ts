/**
 * pi-subagent — shared types for execution backends.
 *
 * Two runner classes swap behind the same result/options shapes. There is no
 * `SubagentRunner` interface — dispatch code branches directly on mode so the
 * seam never leaks.
 */

export interface SubagentResult {
	/** Text returned to the LLM — only the child's output, nothing decorative. */
	output: string;
	/** tmux session name, for interactive sessions (battle/close need it). */
	sessionName?: string;
}

export interface SubagentOptions {
	cwd: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	/** Pre‑generated tmux session name (interactive mode only). */
	sessionName?: string;
	/**
	 * Called when the runner has new output. May be called multiple times
	 * (streaming, as in PrintRunner) or once on completion (InteractiveRunner).
	 */
	onOutput?: (text: string) => void;
}

/** Hard caps. Lifted from pi's bash tool default; sub‑agents shouldn't run unbounded. */
export const DEFAULT_TIMEOUT_MS = 600_000;
