# pi-status-line

[English](README.md) | [中文](README.zh.md)

Pi-native status line — live TPS + TTFT via `ctx.ui.setFooter`, inline with token stats.

Integrated into footer via `setFooter` — `↑`/`↓` right after `↓`, single space `join(" ")` like official `statsParts`, persistent after turn.

| Metric | Definition |
| --- | --- |
| **TPS** | `output+reasoning` tokens / pure decode time (`firstToken → now`), live 1s sliding window, `<250ms` debounced |
| **TTFT** | `turn_start → firstToken` |

Tokens estimated as `chars/4` when provider counts unavailable (OpenAI heuristic); provider-precise counts are a future upgrade.

```
footer:  ↑6.3k ↓119 T1.2s 42.1T/s R113 ... 0.6%/1.0M (model)
                                              ↑ ttft   ↑ tps
```

## How it works

- `turn_start` records `t0` and clears stale values.
- Each `message_update` text delta is estimated, pushed into a 1s `SlidingWindow`, and both statuses re-rendered.
- `turn_end` persists — values stay visible until next `turn_start` overwrites (only `session_shutdown` clears).
- Engine: `tps.ts` is pure (`estimateTokens` / `SlidingWindow` / `TurnMetrics`), testable without pi.

## Future

This package is the home for all footer optimizations (`context%`, `cost`, etc.) — `pi-status-line` as a generic footer collection, not a single-metric package.

## Config

None yet. Display thresholds and estimation strategy are future knobs.
