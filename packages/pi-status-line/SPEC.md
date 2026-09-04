# pi-status-line 设计

## Why：Pi Native 状态栏扩展

pi 的 footer（`Footer` 组件，`render(width): string[]`）内置拼
`model / branch / cost / extensionStatuses`。官方扩展点：

- `ctx.ui.setStatus(key, text)` —— 往 `extensionStatuses: Map` 加一段文本，
  由默认 Footer 自动拼到右侧，多扩展共存空格分隔（Pi Native）。
- `ctx.ui.setFooter(factory)` —— 整行接管（重排版）。

本包采用 **`setFooter` 整行接管**：将 TPS/TTFT 插进 `statsLeft`（`↓` 右侧），与 token 统计同行，单空格 `join(" ")` 与官方一致。

后续 footer 优化（`context%` / `cost` / `branch` 增强等）同属此包，
`pi-status-line` 作为通用 footer 扩展集合，不为单一指标锁死包名。

## Module 清单

| module | 职责 | 接口 |
| --- | --- | --- |
| `tps.ts` | 纯计算：token 估算、滑动窗口、TPS/TTFT 格式化 | `estimateTokens` / `SlidingWindow` / `TurnMetrics` |
| `index.ts` | 扩展入口：`setFooter` 定制 footer + turn/message 驱动 metrics | 默认导出 extension 工厂 |

- `tps.ts` 无 pi 依赖，接口即测试面。`TurnMetrics` 封装单 turn 状态
  （`turnStartMs / firstTokenMs / totalTokens / SlidingWindow(1s)`），
  暴露 `ttftMs / liveTps / averageTps` 派生值。
- 指标定义对齐业界（OpenCode / pi-tps-status）：分子 `output+reasoning`
  （`chars/4` 估算，provider 精确计数后续可替换）、分母纯解码时间
  （`firstToken → now`，工具等待天然排除——`turn_start` 重置）、
  直播 1s 滑动窗口 + `<250ms` 防抖、TTFT 单列。

## 行为

```
turn_start ──► 记录 t0（TTFT 起点）；显示值保持到新一轮第一个 token 到来才覆盖
message_update (text/thinking delta) ──► 估算 tokens（含 reasoning），推滑动窗口，冻结直播 TPS 文本，requestRender
message_end ──► 整轮平均值冻结为最终值
footer render 只读缓存文本，永不以渲染时刻 Date.now() 重算——输入触发的重渲染会让 total/elapsed 分母膨胀、数字边打字边掉
turn_end 之后持久化保留（等下一轮第一个 token 再覆盖），仅 session_shutdown 清空
```

`extractDelta` 取 `assistantMessageEvent.delta`（`text_delta` / `thinking_delta` 均计入分子，对齐业界 output+reasoning）。

## 测试

`SlidingWindow` 窗口裁剪 / `estimateTokens` 边界 / `TurnMetrics`
TTFT/TPS 派生与防抖。扩展接线属 pi 事件面，靠单测 TurnMetrics 覆盖
核心逻辑 + 人工 TUI 冒烟（`pi` 运行中观察 footer）。
