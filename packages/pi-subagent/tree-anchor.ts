/**
 * pi-subagent — where a tree-telemetry event lands.
 *
 * Pure and table-testable: no pi API, no registry.
 */

/** Where a tree-telemetry event lands, as a decision table:
 *  - "forward": non-root — report verbatim (depth + 1) to my parent;
 *  - "widget": root — the subtree renders on the widget.
 *
 *  A root-only decision is the whole rule now: no spawn blocks, so no card is
 *  ever open while a subtree runs, and there is nothing to fold into. */
export type TreeAnchor = "forward" | "widget";

export function resolveTreeAnchor(opts: { hasParent: boolean }): TreeAnchor {
	return opts.hasParent ? "forward" : "widget";
}
