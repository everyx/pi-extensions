# pi-status-line

[English](README.md) | [中文](README.zh.md)

Pi-native status line — live TPS + TTFT via `ctx.ui.setFooter`, inline with token stats.

Integrated into footer via `setFooter` — `↑`/`↓` right after `↓`, single space `join(" ")` like official `statsParts`, persistent after turn.

| Metric | Definition |
| --- | --- |
| **TPS** | `output+reasoning` tokens / wall clock (`firstToken → now`), gaps during generation included, TTFT excluded, `<250ms` debounced |
| **TTFT** | `turn_start → firstToken` |

Tokens: provider-precise `usage.output` at message_end, falling back to a single ceil estimate on cumulative chars (CJK ≈ 1 token/char, other ≈ 4 chars/token) — never per-delta ceil, which inflates the sum.

```
footer:  ↑6.3k ↓119 T1.2s 42.1T/s R113 ... 0.6%/1.0M (model)
                                              ↑ ttft   ↑ tps
```

## How it works

- `turn_start` records `t0` (TTFT start); displayed values persist until the new turn's first token arrives.
- Each `message_update` accumulates chars only (tokens estimated once on the total); the live value is the running average over the generation so far (gaps counted, tool waits excluded structurally via pi's per-generation `turn_start`).
- Values stay visible until the next turn's first token overwrites them (only `session_shutdown` clears).
- Engine: `tps.ts` is pure (`estimateTokens` / `TurnMetrics`), testable without pi.

## Future

This package is the home for all footer optimizations (`context%`, `cost`, etc.) — `pi-status-line` as a generic footer collection, not a single-metric package.

## Config

None yet. Display thresholds and estimation strategy are future knobs.

