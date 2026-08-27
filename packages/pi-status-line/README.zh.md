# pi-status-line

[English](README.md) | [中文](README.zh.md)

Pi 原生的状态栏扩展——通过 `ctx.ui.setFooter` 与 token 统计同行展示 TPS + TTFT。

通过 `setFooter` 集成到 footer——`↑`/`↓` 右侧紧挨，单空格 `join(" ")` 与官方 `statsParts` 一致，turn 结束后持久化。

| 指标 | 定义 |
| --- | --- |
| **TPS** | `output+reasoning` tokens / 纯解码时间（`firstToken → now`），直播 1s 滑动窗口，`<250ms` 防抖 |
| **TTFT** | `turn_start → firstToken` |

Token 暂按 `chars/4` 估算（provider 精确计数后续可接）。

```
footer:  ↑6.3k ↓119 T1.2s 42.1T/s R113 ... 0.6%/1.0M (model)
                                              ↑ ttft   ↑ tps
```

## 工作原理

- `turn_start` 记录 `t0` 并清空旧值。
- 每个 `message_update` 文本增量估算后推入 1s 滑动窗口，两项重渲染。
- `turn_end` 后持久化保留——下一 `turn_start` 再覆盖，仅 `session_shutdown` 清空。
- 引擎：`tps.ts` 纯函数（`estimateTokens` / `SlidingWindow` / `TurnMetrics`），无需 pi 即可单测。

## 后续

本包是所有 footer 优化的归宿（`context%` / `cost` 等）——`pi-status-line` 作为通用状态栏集合，不为单一指标锁名。
