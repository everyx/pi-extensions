# pi-subagent 规格说明

> 通用设计原则（Pi Native / LLM+Token Friendly / 提供能力 / 极简克制）与统一视觉语法见项目级 [`SPEC.md`](../../SPEC.md)；本文件只记录 sub-agent 专属设计。

## 问题陈述

Pi 不支持内置子 agent。当任务会产生大量中间输出（搜索结果、日志、测试输出）污染主会话上下文，或需要并行运行独立任务而不阻塞主对话时，需要一种委托机制：

- **上下文隔离**：子任务的中间过程不应进入主上下文。
- **并行**：多个独立任务可同时进行，主 agent 不被阻塞。
- **可干预**：运行中的子任务可被消息重定向（agent_send）或终止（agent_stop）。
- **可观测**：运行状态在 TUI 中可见，完成后可复盘完整会话。

> **并行**由 pi 原生支持：LLM 一次响应中发出多个 tool call 时，pi 并发执行所有调用。subagent 不内置自己的并行机制。

## 解决方案

一个 pi 扩展，注册三个动词后缀原语工具（对齐 pi 生态动词风格：`read`/`write`/`edit`/`web_search`；无 action 枚举、家族扩展自然）：

- **`agent_spawn`** — 创建隔离的子 agent（前台阻塞 / 后台异步；可选 `persistent` 常驻）。
- **`agent_stop`** — 销毁运行中的子 agent（常驻与否都适用）。
- **`agent_send`** — 实体间消息通信（父→子、子→父双向；树路径 / `@parent` 寻址）。

每个子 agent 是一个常驻 `pi --mode rpc` 子进程，拥有独立上下文与持久化会话。

## 用户故事

1. 委托子 agent 研究问题，不污染主会话上下文窗口，输出纯文本直接可用。
2. 并行探索多个独立问题——多个后台子 agent 同时运行，widget 显示状态，完成通知逐个到达。
3. 后台 agent 跑偏时发消息重定向，或直接 agent_stop 终止。
4. 为每个子 agent 独立覆盖模型和工具白名单（如廉价模型做侦察，强模型做实现）。
5. 子 agent 完成后从主会话（工具卡/通知卡）找到 session 路径，`pi --session <path>` 复盘完整过程。
6. 嵌套：子 agent 是完整 pi 实例，天然可再 spawn 孙 agent，无深度控制。
7. 父级退出时子进程经 stdin EOF 自动优雅退出（无孤儿进程），会话文件永不删除。
8. 协作：子 agent 中途遇到阻塞（缺信息/需决策），发消息给父会话请求帮助；父回复后子 agent 继续，上下文不丢。
9. 常驻：`persistent` 子 agent 完成后进程驻留 idle（零 token），之后随时被 `agent_send` 唤醒继续追问，无需重新 spawn。

## UI 设计

### agent_spawn 工具卡片

```
✓ agent_spawn "检查 CI 配置" (sonnet · high · Took 27.5s)
⠙ agent_spawn "检查 CI 配置" (claude-sonnet · high · Elapsed 12.3s)
Thinking...
bash: pnpm check
<空行>
... (12 earlier lines, ctrl+o to expand)
<子 agent 输出尾部 5 行>
<空行>
session: /path/...jsonl
```

- header：`⠋/✓/✗` + `agent_spawn` + `"title"` + muted meta——时间从 state 共享；`run_in_background` 时 renderCall 返回空（后台 spawn 用独立结果卡）
- body：混合活动流——prompt 在流头，随后按事件顺序渲染子 agent 会话（Thinking... / 工具调用 / 流式文本）；随输出增长 prompt 与早期活动滚出折叠区
- footer：仅 `session: <path>`
- 推理强度：`thinking` 参数（"off"…"max"），省略时继承主会话当前值

**后台 spawn 结果卡**（原地切换）：

```
⠋ agent_spawn "检查 CI 配置" starting…
✓ agent_spawn "检查 CI 配置" started
✗ agent_spawn "检查 CI 配置" start failed
  Model not found
```

- 状态一眼可辨（icon 前置）；失败原因按统一折叠规则处理（默认尾部预览 + 展开全显，对齐 bash 工具卡）
- 后台 agent id 只进 LLM 的 tool content，卡片上不出现

### agent_stop / agent_send 结果卡

```
✓ agent_stop "research db schema" stopped

✓ agent_send → "research db schema" delivered
  重点看 orders 表的索引和慢查询

✓ agent_send → @parent delivered
  我已经检查完，需要你确认部署窗口

✗ agent_stop "slow query probe" stop failed
  agent not found
```

- agent_send 的 `to` 可寻址子 agent（树路径 / 简短 id）或 `@parent`（父会话）
- 注入的消息以普通文本显示在卡片内，完整多行，超 5 行按统一折叠规则处理
- 动画帧在同一行内切换，绝不追加新行
- 错误保持同一形态：状态行 error 色 + dim 原因行

### 完成通知卡片（persistent 时带 idle 标记）

```
✓ agent_spawn "检查 CI 配置" (sonnet · high · Took 27.5s · 1,250 tokens · 3 tool uses · idle)
<空行>
... (3 earlier lines, ctrl+o to expand)
Found 5 files handling authentication: src/auth/*.ts …
<空行>
session: /path/...jsonl
```

- header：状态 icon 在最前（✓/✗/■）——icon 与 agent_spawn 工具卡同款（工具卡同样前置 icon）；通知卡独有的是追加状态词（`failed` error / `stopped` warning / `idle` muted）与 token/工具统计
- 失败/停止时追加彩色状态词（`failed` error / `stopped` warning）；persistent 完成追加 `idle` muted
- 渲染数据在 `details`，不进 LLM 上下文

### Agents 状态 widget（aboveEditor）

```
  ● Agents 1/3
  ⠋ 检查 CI 配置 (42.0s)
  … 检查 CI 配置 (idle)
```

- 仅跟踪后台 agent（前台已 inline 流式，不重复）
- 非 persistent 完成/停止立即移除——完成结果由通知卡承担；**persistent 完成后保留 idle 行**（可寻址性可见，状态词 `idle`，不参与进度计数，可被 agent_stop 移除）
- 标题后显示生命周期进度 `已结束/累计`（如 `1/3`）；含失败/停止时为 `(1+2)/3`
  （成功+异常，异常数 error 色）——行空 widget 消失，计数随下次任务批重置
- 每行下方追加最新活动摘录（缩进 3 字符）：工具调用、Thinking...、或最新正文尾部

## 实现决策

### 架构

```
index.ts           — 工具注册（agent_spawn / agent_stop / agent_send）+ schema + 通知投递
protocol.ts        — 纯函数 JSONL 协议层
rpc-client.ts      — 状态化薄 JSONL 客户端（spawn + 事件流 + 退出）
event-interpret.ts — 原始 RpcEvent → AgentEvent 适配层（纯函数）
agent-process.ts   — AgentProcess：一个常驻 rpc 子进程的语义封装
registry.ts        — AgentRegistry：运行中 Agent 生命周期 + 树状消息路由 + 完成策略
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
- **父→子消息投递（机制层自动选，LLM 无感知）**：统一发 `prompt` 并传 `streamingBehavior: "steer"`——一个命令覆盖全部状态，无 fallback、无状态判断、无竞态：
  - 子 idle → 正常起新 turn（唤醒）✓ 实证
  - 子 running → 自动入 steer 队列（当前 turn 结束后消费），不报错 ✓（源码确定）
  - 绝不用裸 steer 发 idle 消息：命令假装成功、消息静默挂起永不消费（实证）——违反能力缺失不静默原则

### 生命周期

```
queued → running ──→ completed（通知）
                  ├── failed（API 错误/崩溃，通知）
                  └── stopped（超限，通知；agent_stop，无通知）
       persistent：completed → idle（进程驻留，零 token）──→ stopped（agent_stop）
```

- **就绪判定**：prompt 命令 preflight 回执
- **persistent**：显式开启（`agent_spawn(persistent: true)`），默认不常驻（行为不变）——"不设隐藏限制，限制由调用者显式要求"；前台/后台都支持（前台阻塞等待 + 完成后进程保留 idle，可后续唤醒追问，功能不矛盾）
- **idle 语义**：进程驻留、零 token（rpc 模式命令驱动，无 turn 不调模型）；完成通知带 `idle` 标记；widget 保留 idle 行（可寻址性可见）；可被 agent_stop 杀掉
- **stop**：stdin EOF 优雅退出，`stoppedByControl` 抑制通知
- **失败与超限都返回 isError 工具结果**，与 bash 的 `exit N` / `(cancelled)` 对齐
- **扩展 reload 不留孤儿**：reload 时 pi 在旧扩展 runner 上派发 `session_shutdown(reason="reload")`（旧 handler 仍在活跃状态），扩展统一调 `registry.shutdown()` 优雅停掉本实例的子代理（stdin EOF）；宿主崩溃时子代理经 stdin EOF 自动退出。所有清理都绑定在**各自进程**的事件上，无跨进程共享状态，多 pi 实例互不干扰

### 消息模型（树状，只允许父子边）

```
主会话 (root)
├── a1 ────── registry 持有直接子
│   └── a1/a1-1（孙）
└── a2
```

- **寻址**：树路径 id（spawn 时父传路径前缀，`a1` 的孩子 `a1/a1-1`）+ `@parent`（最近的父 LLM）；无目录、无全局注册表、无跨进程共享状态
- **路由（每跳 O(1)，纯函数）**：消息目标是直接子 → 下投（rpc）；否则 → 上抛给父；root 仍找不到 → 报错回源
- **中转经父 LLM 上下文**：跨层/兄弟消息必然进入途经父 LLM 的会话（通道即会话）——这是树状协调的固有 token 代价，KISS 接受；promptGuidelines 正向引导，不罗列不推荐场景
- **发现机制很薄**：子知道谁 = 父 spawn prompt 告知 + 消息 from 字段（文本 `[from a1]` 前缀，rpc 投递只传字符串，文本级标注最省）

### 通道（零新端点，全复用现有基础设施）

```
父→子：现有 rpc（prompt / steer，见 RPC 协议投递策略）
子→父：extension_ui_request（rpc 模式 setStatus 携带 JSON，专属 key "pi-subagent-msg"；
        fire-and-forget 尽力投递，无确认——本地 rpc 通行可靠）
注入/唤醒：pi.sendMessage（deliverAs: "steer"|"followUp" + triggerTurn: true）
```

- **零 socket、零文件写入、零轮询**——纯内存事件流
- 注入语义（已实证）：父 streaming（工具 execute 挂起/LLM 跑）→ 消息排队不抢占；父空闲 → 立即起新 turn 唤醒
- 事件天然带身份：每个 AgentProcess 持有自己的 RpcClient 连自己的子进程——收到 extension_ui_request 的 client 即消息来源，无需 id 字段
- 身份注入：spawn 时环境变量 `PI_SUBAGENT_AGENT_ID`（树路径）、`PI_SUBAGENT_PARENT`（父身份）；子进程扩展检测到才注册 agent_send 工具与 UI 上报

### 基石验证（2026-08-10 实证）

| 假设 | 结果 |
|---|---|
| 子进程扩展调 pi.sendMessage(deliverAs: "steer", triggerTurn: true) 注入自己会话 | ✅ 唤醒第二轮 |
| idle agent 被 triggerTurn 唤醒 | ✅ |
| 子进程扩展 extension_ui_request（setStatus）被父 rpc-client 完整收到 | ✅ 无节流/去重/长度限制（rpc-mode.js fire-and-forget） |
| rpc-client 对未知事件类型宽容处理 | ✅ 不认识即忽略 |
| **裸 steer 发 idle 会话** | ✅ 命令成功但消息静默挂起——**禁用此路径**（投递策略见 RPC 协议） |
| **prompt + streamingBehavior:"steer" 发 idle 会话** | ✅ 可靠起新 turn（定稿投递策略） |
| **prompt + streamingBehavior:"steer" 发 running 会话** | ✅ 自动入队不报错（源码确定：SB 存在则不 throw，走 steer 队列） |

### 完成通知

- `pi.sendMessage` → `deliverAs: "followUp"` + `triggerTurn: true`
- content：`{status, agent_id, result, session_path}`（LLM 可见）；persistent 时追加 `idle: true`
- details：渲染数据，不进 LLM 上下文；persistent 通知卡追加 idle 状态词
- spawn 失败不投递通知：isError 工具结果已经同时告知 LLM 和用户，followUp 通知会重复

### Graceful turn limits

- **默认不限**——对齐 Codex/CC 的克制姿态。唯一限制是可选 `timeoutMs`（毫秒），未传 = 无限制
- token 无任何限制；`get_session_stats` 仅用于通知卡统计

### 会话存储

- 目录在 pi 标准会话树之外——`pi -r` 保持干净；永不删除
- `--name` 仅当显式提供 title 时传（否则跟随 pi 默认）
- attach：`pi --session <path>`

### 嵌套

子实例是完整 pi（加载全局扩展），天然可再 spawn；不注入 depth、不设 max_depth。子进程扩展经环境变量获得自身身份（`PI_SUBAGENT_AGENT_ID` / `PI_SUBAGENT_PARENT`）——孙 agent 的树路径由父 spawn 时传入。

### 上游限制：isError 被丢弃（workaround）

- **现象**：扩展工具 `execute()` 返回 `{ isError: true }` 时，TUI 卡片仍显示成功背景。
- **根因**：pi-agent-core 的 `executePreparedToolCall` 在工具正常返回时硬编码 `isError: false`——只有 throw 异常才能拿到 `isError: true`。该行为自 2025-09-09 引入，上游 issue **#5209** 被维护者拒绝，预期不会修复。
- **workaround**：所有错误路径的 `details` 带 `error` 字段；注册 `pi.on("tool_result")` hook 检测 `details.error` → 返回 `{ isError: true }`。该 hook 走 `afterToolCall` 的官方覆盖通道，既修正 isError 又保留 details；官方推荐的 throw 方式会清空 details，故不采用。

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

- 扩展经 `~/.pi/agent/extensions/` 或 `pi install` 加载；子 pi 实例（嵌套场景）同样加载扩展，天然获得 agent_spawn / agent_stop / agent_send 工具。
- headless（`pi -p`）：主 agent 响应结束即进程退出，后台子 agent 经 stdin EOF 被清理（无孤儿）；后台工作流面向常驻 TUI 会话。
