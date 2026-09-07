# pi-status-line

[English](README.md) | [中文](README.zh.md)

Pi 原生的状态栏扩展——通过 `ctx.ui.setFooter` 与 token 统计同行展示 TPS + TTFT。

通过 `setFooter` 集成到 footer——`↑`/`↓` 右侧紧挨，单空格 `join(" ")` 与官方 `statsParts` 一致，turn 结束后持久化。

| 指标 | 定义 |
| --- | --- |
| **TPS** | `output+reasoning` tokens / 全程墙钟（`firstToken → now`），生成内卡顿计入、TTFT 排除，`<250ms` 防抖 |
| **TTFT** | `turn_start → firstToken` |

Token：`message_end` 优先 provider 精确 `usage.output`，无则回退累计字符一次性取整估算（CJK 字≈1 token、其他≈/4）——绝不逐 delta 取整，那会系统性虚高。

```
footer:  ↑6.3k ↓119 T1.2s 42.1T/s R113 ... 0.6%/1.0M (model)
                                              ↑ ttft   ↑ tps
```

## 工作原理

- `turn_start` 记录 `t0` 并清空旧值。
- 每个 `message_update` 只累计字符（token 在累计总量上一次性估算）；直播值 = 生成至今的运行平均（卡顿计入，工具等待靠 pi 每次生成段的 `turn_start` 结构性排除）。
- `turn_end` 后持久化保留——下一 `turn_start` 再覆盖，仅 `session_shutdown` 清空。
- 引擎：`tps.ts` 纯函数（`estimateTokens` / `TurnMetrics`），无需 pi 即可单测。

## 后续

本包是所有 footer 优化的归宿（`context%` / `cost` 等）——`pi-status-line` 作为通用状态栏集合，不为单一指标锁名。
