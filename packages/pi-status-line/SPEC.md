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
| `tps.ts` | 纯计算：累计 token 估算、TPS/TTFT 格式化 | `estimateTokens` / `TurnMetrics` |
| `index.ts` | 扩展入口：`setFooter` 定制 footer + turn/message 驱动 metrics | 默认导出 extension 工厂 |

- `tps.ts` 无 pi 依赖，接口即测试面。`TurnMetrics` 封装单 turn 状态
  （`turnStartMs / firstTokenMs / totalChars / totalCjkChars`），
  暴露 `ttftMs / liveTps / averageTps` 派生值。
- 指标定义对齐业界（见下）：分子 `output+reasoning`
  （CJK/Kana/Hangul 字≈1 token、其他≈/4，**累计字符一次性取整**——逐 delta
  `ceil` 会系统性虚高，实测 token 对齐流 +40%、逐字流 +284%），
  分母**首 token → now/end 全程墙钟**（Vercel AI SDK `outputTokensPerSecond` /
  MLPerf ITL 同口径；生成内卡顿计入，TTFT 单列排除）；
  终值优先 provider 精确 `usage.output`，无则回退估算。
- **live = 运行平均**（终值的中间表述），不是瞬时速率——chunk 时序是传输工件，
  “瞬时”在客户端不可观测；运行平均单调收敛到终值，仅一次估算→精确跳变。
- **工具等待天然排除**：pi 的 `turn_start` 每次生成段都发一次（agent-core
  agent-loop 实证），工具执行落在 turn 之间，无需显式暂停计时。
- TTFT 单列（`turn_start → firstToken`，会话平均）。

## 行为

```
turn_start ──► 记录 t0（TTFT 起点）；显示值保持到新一轮第一个 token 到来才覆盖
message_update (text/thinking delta) ──► 只累计字符（不逐 delta 估算）；冻结直播 TPS = 运行平均（估算分子 / 首token→now 全程墙钟），requestRender
message_end ──► 终值冻结：provider 精确 usage.output（无则回退估算） / 首token→末token 墙钟
footer render 只读缓存文本，永不以渲染时刻 Date.now() 重算——输入触发的重渲染会让 total/elapsed 分母膨胀、数字边打字边掉
turn_end 之后持久化保留（等下一轮第一个 token 再覆盖），仅 session_shutdown 清空
```

`extractDelta` 取 `assistantMessageEvent.delta`（`text_delta` / `thinking_delta` 均计入分子，对齐业界 output+reasoning）。

## 测试

`estimateTokens` 边界（含 CJK 权重）/ `TurnMetrics` 的 TTFT、防抖、
运行平均、卡顿计入、一次性取整防虚高、精确分子优先与回退。
扩展接线属 pi 事件面，靠单测 TurnMetrics 覆盖核心逻辑 + 人工 TUI 冒烟
（`pi` 运行中观察 footer）。
