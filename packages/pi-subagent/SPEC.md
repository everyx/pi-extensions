# pi-subagent 规格说明

> 通用设计原则（Pi Native / LLM+Token Friendly / 提供能力 / 极简克制）与统一视觉语法见项目级 [`SPEC.md`](../../SPEC.md)；本文件只记录 sub-agent 专属设计。

## 问题陈述

Pi 不支持内置子 agent。当任务会产生大量中间输出（搜索结果、日志、测试输出）污染主会话上下文，或需要并行运行独立任务而不阻塞主对话时，需要一种委托机制：

- **上下文隔离**：子任务的中间过程不应进入主上下文。
- **并行**：多个独立任务可同时进行，主 agent 不被阻塞。
- **可干预**：运行中的子任务可被重定向（steer）或终止（stop）。
- **可观测**：运行状态在 TUI 中可见，完成后可复盘完整会话。

> **并行**由 pi 原生支持：LLM 一次响应中发出多个 tool call 时，pi 并发执行所有调用。subagent 不内置自己的并行机制。

## 解决方案

一个 pi 扩展，注册两个原语工具：

- **`Agent`** — spawn 一个隔离的子 agent（前台阻塞 / 后台异步）。
- **`AgentControl`** — 干预运行中的后台 agent（steer / stop）。

每个子 agent 是一个常驻 `pi --mode rpc` 子进程，拥有独立上下文与持久化会话。

## 用户故事

1. 委托子 agent 研究问题，不污染主会话上下文窗口，输出纯文本直接可用。
2. 并行探索多个独立问题——多个后台 Agent 同时运行，widget 显示状态，完成通知逐个到达。
3. 后台 agent 跑偏时注入 steer 消息重定向，或直接 stop 终止。
4. 为每个子 agent 独立覆盖模型和工具白名单（如廉价模型做侦察，强模型做实现）。
5. 子 agent 完成后从主会话（工具卡/通知卡）找到 session 路径，`pi --session <path>` 复盘完整过程。
6. 嵌套：子 agent 是完整 pi 实例，天然可再 spawn 孙 agent，无深度控制。
7. 父级退出时子进程经 stdin EOF 自动优雅退出（无孤儿进程），会话文件永不删除。
8. 扩展零运行时 npm 依赖（仅 peerDependencies：pi-ai / pi-coding-agent / pi-tui / typebox）。

## UI 设计

### Agent 工具卡片

```
✓ Agent "检查 CI 配置" (sonnet · high · Took 27.5s)
⠙ Agent "检查 CI 配置" (claude-sonnet · high · Elapsed 12.3s)
Thinking...
bash: pnpm check
<空行>
... (12 earlier lines, ctrl+o to expand)
<子 agent 输出尾部 5 行>
<空行>
session: /path/...jsonl
```

- header：`⠋/✓/✗` + `Agent` + `"title"` + muted meta——时间从 state 共享；`run_in_background` 时 renderCall 返回空（后台 spawn 用独立结果卡）
- body：混合活动流——prompt 在流头，随后按事件顺序渲染子 agent 会话（Thinking... / 工具调用 / 流式文本）；随输出增长 prompt 与早期活动滚出折叠区
- footer：仅 `session: <path>`
- 推理强度：`thinking` 参数（"off"…"max"），省略时继承主会话当前值

**后台 spawn 结果卡**（原地切换）：

```
⠋ Agent "检查 CI 配置" starting…
✓ Agent "检查 CI 配置" started
✗ Agent "检查 CI 配置" start failed
  Model not found
```

- 状态一眼可辨（icon 前置）；失败原因按统一折叠规则处理（默认尾部预览 + 展开全显，对齐 bash 工具卡）
- 后台 agent id 只进 LLM 的 tool content，卡片上不出现

### AgentControl 结果卡

```
✓ Agent "research db schema" steered
  重点看 orders 表的索引和慢查询

⠹ Agent "slow query probe" stopping…
✓ Agent "slow query probe" stopped

✗ Agent "slow query probe" stop failed
  agent not found
```

- steer 注入的消息以普通文本显示在卡片内，完整多行，超 5 行按统一折叠规则处理
- 动画帧在同一行内切换，绝不追加新行
- 错误保持同一形态：状态行 error 色 + dim 原因行

### 完成通知卡片

```
✓ Agent "检查 CI 配置" (sonnet · high · Took 27.5s · 1,250 tokens · 3 tool uses)
<空行>
... (3 earlier lines, ctrl+o to expand)
Found 5 files handling authentication: src/auth/*.ts …
<空行>
session: /path/...jsonl
```

- header：状态 icon 在最前（✓/✗/■）——icon 与 Agent 工具卡同款（工具卡同样前置 icon）；通知卡独有的是追加状态词（`failed` error / `stopped` warning）与 token/工具统计
- 失败/停止时追加彩色状态词（`failed` error / `stopped` warning）
- 渲染数据在 `details`，不进 LLM 上下文

### Agents 状态 widget（aboveEditor）

```
  ● Agents
  ⠋ 检查 CI 配置 (42.0s)
```

- 仅跟踪后台 agent（前台已 inline 流式，不重复）
- 完成/停止立即移除——完成结果由通知卡承担
- 每行下方追加最新活动摘录（缩进 3 字符）：工具调用、Thinking...、或最新正文尾部

## 实现决策

### 架构

```
index.ts           — 工具注册（Agent / AgentControl）+ schema + 通知投递
protocol.ts        — 纯函数 JSONL 协议层
rpc-client.ts      — 状态化薄 JSONL 客户端（spawn + 事件流 + 退出）
event-interpret.ts — 原始 RpcEvent → AgentEvent 适配层（纯函数）
agent-process.ts   — AgentProcess：一个常驻 rpc 子进程的语义封装
registry.ts        — AgentRegistry：运行中 Agent 生命周期 + 完成策略
model.ts           — model spec → resolved model（纯函数）
types.ts           — 共享协议类型（RenderEvent / SubagentDetails / NotificationDetails）
format.ts          — 纯函数格式化工具（SPINNER / formatDuration / safeTitle / activityRow 等）
render.ts          — TUI 渲染（工具卡 / 控制卡 / 通知卡）
widget.ts          — Agents 状态 widget
preview.ts         — dev-only storybook：`npm run preview` 逐组件渲染预览（不进生产包）
```

### RPC 协议

- 线格式：JSONL（LF 分隔，与 pi 的 jsonl.js 一致），命令带 id 关联
- 子进程 detached（独立进程组）：stop 的 SIGTERM 级联到整棵进程树，不遗留孤儿孙进程
- 自写薄客户端：不绑定 pi 框架私有 RpcClient

### 生命周期

```
queued → running ──→ completed（通知）
                  ├── failed（API 错误/崩溃，通知）
                  └── stopped（超限，通知；AgentControl.stop，无通知）
```

- **就绪判定**：prompt 命令 preflight 回执
- **steer**：turn 结束后注入，排队语义；仅 running 期间有效
- **stop**：stdin EOF 优雅退出，`stoppedByControl` 抑制通知
- **失败与超限都返回 isError 工具结果**，与 bash 的 `exit N` / `(cancelled)` 对齐
- **扩展 reload 不留孤儿**：reload 时 pi 在旧扩展 runner 上派发 `session_shutdown(reason="reload")`（旧 handler 仍在活跃状态），扩展统一调 `registry.shutdown()` 优雅停掉本实例的子代理（stdin EOF）；宿主崩溃时子代理经 stdin EOF 自动退出。所有清理都绑定在**各自进程**的事件上，无跨进程共享状态，多 pi 实例互不干扰

### 完成通知

- `pi.sendMessage` → `deliverAs: "followUp"` + `triggerTurn: true`
- content：`{status, agent_id, result, session_path}`（LLM 可见）
- details：渲染数据，不进 LLM 上下文
- spawn 失败不投递通知：isError 工具结果已经同时告知 LLM 和用户，followUp 通知会重复

### Graceful turn limits

- **默认不限**——对齐 Codex/CC 的克制姿态。唯一限制是可选 `timeoutMs`（毫秒），未传 = 无限制
- token 无任何限制；`get_session_stats` 仅用于通知卡统计

### 会话存储

- 目录在 pi 标准会话树之外——`pi -r` 保持干净；永不删除
- `--name` 仅当显式提供 title 时传（否则跟随 pi 默认）
- attach：`pi --session <path>`

### 嵌套

子实例是完整 pi（加载全局扩展），天然可再 spawn；不注入 depth、不设 max_depth。

### 上游限制：isError 被丢弃（workaround）

- **现象**：扩展工具 `execute()` 返回 `{ isError: true }` 时，TUI 卡片仍显示成功背景。
- **根因**：pi-agent-core 的 `executePreparedToolCall` 在工具正常返回时硬编码 `isError: false`——只有 throw 异常才能拿到 `isError: true`。该行为自 2025-09-09 引入，上游 issue **#5209** 被维护者拒绝，预期不会修复。
- **workaround**：所有错误路径的 `details` 带 `error` 字段；注册 `pi.on("tool_result")` hook 检测 `details.error` → 返回 `{ isError: true }`。该 hook 走 `afterToolCall` 的官方覆盖通道，既修正 isError 又保留 details；官方推荐的 throw 方式会清空 details，故不采用。

## 测试决策

- 纯函数全面单测：`protocol.ts`、`model.ts`、`event-interpret.ts`
- 状态化语义经 seam 测试：`agent-process.ts`（createClient 注入 fake）、`rpc-client.ts`（命令关联 + UTF-8）、`registry.ts`（生命周期 + 完成策略）
- 渲染语义测试：`render.ts` 通过 mock details 驱动纯渲染输出
- LLM context 截断：`truncateForContext` 直接单测
- 基础设施不测：真实 spawn / rpc 传输，以 E2E 冒烟验证

## 不在此范围

- **预定义 agent 类型系统**：agent 由调用者参数完全定义。
- **schedule / 定时任务**。
- **worktree 隔离**。
- **fleet view / conversation viewer**：不渲染子对话流；attach 走 pi 原生 `--session <path>`。
- **并发上限 / 排队**：多后台 = 多进程，LLM/用户自负其责。
- **结果查询工具**：通知一次投递，不做轮询/查询原语。
- **Windows 支持**：依赖 POSIX 进程与管道语义。
- **会话删除**：子会话永不删除，供复盘。

## 其它说明

- 扩展经 `~/.pi/agent/extensions/` 或 `pi install` 加载；子 pi 实例（嵌套场景）同样加载扩展，天然获得 Agent 工具。
- headless（`pi -p`）：主 agent 响应结束即进程退出，后台子 agent 经 stdin EOF 被清理（无孤儿）；后台工作流面向常驻 TUI 会话。
