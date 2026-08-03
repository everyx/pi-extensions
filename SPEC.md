# pi-subagent 规格说明

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

## 设计原则

### Pi Native

- **一致的调用方式**：参数 schema、命名风格与 pi 内置工具（`bash`、`read` 等）保持一致；`promptSnippet` / `promptGuidelines` 注入系统提示。
- **一致的输出质感**：渲染复用 pi 原生组件（`Text`、`Container`、`setWidget`、`registerMessageRenderer`），排版、颜色、折叠展开遵循内置工具（bash 工具卡片）的惯例；widget 与内置 working 指示器同一视觉语言（accent spinner 80ms + muted 文本）。
- **一致的视觉家族**：工具卡 `Agent <title>`、通知卡 `Agent ✓ <title>`、总览 `Agents`——不出现 "subagent" 字样、无装饰 emoji（通知卡状态 icon 除外）。
- **依赖原生能力**：会话存储/attach 走 pi 原生机制（`--session <path>`），不自造会话管理。

### LLM + Token Friendly

- **Token Economy**：通知的 `content`（LLM 可见）只含最小结构化信息（status / agent_id / result / session_path）；装饰性元素（title、usage、session 路径）放 `details`——源码核实 `convertToLlm` 只转 `content`，`details` 永不进入 LLM 上下文。
- **纯函数隔热层**：协议序列化/解析（`protocol.ts`）、模型解析（`model.ts`）是无副作用的纯函数，可独立单测。
- **不轮询**：后台结果由完成通知一次投递，无查询工具（promptGuidelines 写死 "Never poll"）。

### 提供能力而非方案

提供原语，让用户组合。组合逻辑在调用者的 prompt 里，不在工具层。
不封装工作流模板、不自动重试、不做结果后处理、不做预定义 agent 类型系统。

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

### 统一视觉语法

`<bold 工具名> + <icon?> + <title> + <muted 括号 meta>` → 1 空行 → `toolOutput body（prompt 与输出同一流，折叠为尾部预览）` → 1 空行 → `muted footer`。

### Agent 工具卡片

```
Agent 检查 CI 配置 (sonnet)
Thinking...                  ← 活动行（思考中：italic + thinkingText，pi 隐藏 thinking 同款）
bash: pnpm check             ← 活动行（工具调用：工具名 toolTitle + 冒号 + muted 参数）
<空行>
... 12 earlier lines (ctrl+o to expand)   ← 折叠提示（muted + keyHint；被折叠的是流的头部：prompt + 早期输出）
<子 agent 输出尾部 5 行>          ← 输出（前台流式逐字滚动；折叠时只显示最新尾部，展开全显）
<空行>
Took 27.5s
session: /path/...jsonl
```

- header：`Agent`（bold toolTitle）+ title（必填 3-5 词）+ muted meta `(background · model)`——只显示显式参数（run_in_background / model），对齐 bash 的 ` (timeout 10s)`
- 活动行（widget 对齐，仅前台流式期间）：`Thinking...`（italic + thinkingText）与工具调用（工具名 toolTitle + 参数），数据同 widget 的 `latestActivity`（不进 LLM context）；正文本身已流式，故不重复显示 text 活动
- body：prompt 与输出**同一流**——prompt 在流头、header 的 title 承担固定标识，折叠时整流截为尾部 5 行（`... N earlier lines (<key> to expand)`，N 含被折叠的 prompt 与早期输出）；展开全显（prompt 在顶部随滚动流逝）；折叠/展开经 keyHint 绑定键切换
- footer：`Took/Elapsed X.Xs`（muted）+ `session: <path>`（前台完成时）
- 推理强度：`thinking` 参数（"off"…"max"），省略时继承主会话当前值（`pi.getThinkingLevel()`），经 `--thinking` 传给子进程

### AgentControl 卡片

```
Agent steer a1b2c3
<空行>
<注入的 steer 消息全文>            ← 输入（短消息，同流头）
<空行>
<agent 当前输出快照尾部 5 行>      ← 输出（steer 时刻 get_last_assistant_text，details 专用；折叠同 Agent 卡）
<空行>
Steered agent a1b2c3.            ← muted 确认
```

- steer 是 Agent 卡片的**接力**：同一输入/输出 body 结构（LLM 语义不变——立即返回，结果仍由完成通知送达）
- stop：footer-only 完整卡（header + muted 确认 `Stopped agent a1b2c3.`），与 steer 同构；无输出可展示，错误路径（未知 agent 等）仍为 dim 一行

### 完成通知卡片（registerMessageRenderer）

```
Agent ✓ 检查 CI 配置 (Took 27.5s · 1,250 tokens · 3 tool uses)
<空行>
... 3 earlier lines (ctrl+o to expand)      ← 折叠提示（同工具卡；muted + keyHint）
Found 5 files handling authentication: src/auth/*.ts …
<空行>
session: /path/...jsonl
```

- header：`Agent` + 状态 icon（✓ completed / ✗ failed / ⛔ stopped）+ title + muted meta（usage 并入括号）；状态词仅在失败时显示（`failed` / `stopped`）
- body：结果预览，同一流折叠策略（尾部 5 行 + `... N earlier lines (<key> to expand)`；展开全显）
- footer：session 路径
- 渲染数据在 `details`，不进 LLM 上下文

### Agents 状态 widget（setWidget，aboveEditor）

```
（容器级 1 空行，pi 自动）
  ● Agents                    ← accent 标题
  ⠋ 检查 CI 配置 · 42.0s       ← 每行：accent spinner（80ms 帧）+ muted 文本；1 空格左 padding（对齐 pi string[] widget 形式）
```

- 仅跟踪后台 agent（前台已 inline 流式，不重复）
- 完成/停止即移除该行，最后一个结束后 widget 自动清除
- 与 pi 内置 working 指示器（Loader）同一视觉语言
- 每行下方追加**最新活动摘录**（缩进 3 字符，与标题左对齐）：工具调用（工具名 toolTitle 色 + 冒号 + muted 参数摘要）、`Thinking...`（italic + thinkingText，pi 隐藏 thinking 同款）、或最新正文尾部（muted，截断 60 字符）；数据取自 `message_update` 累积消息的最新 content 部分，不进 LLM context

## 实现决策

### 架构

```
index.ts           — 工具注册（Agent / AgentControl）+ schema + 通知投递
protocol.ts        — 纯函数 JSONL 协议层（serializeCommand / parseLine）
rpc-client.ts      — 状态化薄 JSONL 客户端（spawn + pending map + 事件流 + 退出）
event-interpret.ts — 原始 RpcEvent → AgentEvent 适配层（纯函数，单测）
agent-process.ts   — AgentProcess：一个常驻 rpc 子进程的语义封装
registry.ts        — AgentRegistry：运行中 Agent 生命周期 + 完成策略（测试）
model.ts           — model spec → resolved model（纯函数）
render.ts          — TUI 渲染（工具卡 / 通知卡 / 接力卡）
widget.ts          — Agents 状态 widget
```

### RPC 协议（自写薄客户端，方案 II）

- 线格式：JSONL（LF 分隔，与 pi 的 jsonl.js 一致）
- 命令：`prompt` / `steer` / `abort` / `get_last_assistant_text` / `get_state` / `get_session_stats`（带 id 关联）
- 响应：`{id, type:"response", command, success, data|error}`
- 事件：`agent_settled` / `agent_end` / `message_update` 等全事件流
- 不绑定框架 `RpcClient`（私有 + setTimeout 赌就绪 + SIGTERM→SIGKILL 脏点）

### 生命周期

```
queued → running ──→ completed（通知）／ failed（API 错误/崩溃，通知）／ stopped（超限，通知；AgentControl.stop，无通知）
```

- **就绪判定**：prompt 命令 preflight 回执（`success:true`）——两道信号之一；`agent_settled` 为完成信号
- **前台**：spawnAndSend → waitForCompletion（含 graceful limits 循环）→ lastOutput → stdin.end()（优雅退出）
- **后台**：spawnAndSend 后立即返回 agent_id；waitForCompletion resolve 后投递通知 → stdin.end() 退出
- **steer**：写 `steer` 命令（turn 结束后注入，排队语义）；仅 running 期间有效
- **stop**：stdin.end() 优雅退出，5s 未退 SIGTERM 兜底；`stoppedByControl` 抑制通知
- **异常**：agent_end `stopReason:"error"` → failed（错误信息进输出）；子进程非零退出 → failed；RPC stdin 关闭竞态（write-after-end）→ 优雅 reject

### 完成通知

- `pi.sendMessage({customType:"subagent-notification", content: <JSON>, display:true, details}, {deliverAs:"followUp", triggerTurn:true})`
- content：`{status, agent_id, result, session_path}`（LLM 一次拿全）
- details：`{title, result, usage, sessionPath, sessionId}`（卡片渲染，不进 LLM）
- 一次投递、无重试、无查询工具

### Graceful turn limits

- 每轮 settled 后查 `get_session_stats`：≥400k tokens → steer "wrap up"；≥500k tokens 或总时长 ≥600s → `abort` 命令 → 观察 settled → stdin.end() 兜底（三段式）

### 会话存储

- 目录：`<agentDir>/subagent-sessions`（默认 `~/.pi/agent/subagent-sessions/`；`PI_SUBAGENT_SESSION_DIR` 覆盖；尊重 `PI_CODING_AGENT_DIR`）
- 刻意在 pi 标准会话树之外——`pi -r` 保持干净；主会话（工具卡 + 通知卡携带 session path）作为索引
- 文件命名与 pi 一致（`{timestamp}_{sessionId}.jsonl`），永不删除
- `--name` 仅当显式提供 title 时传（否则跟随 pi 默认：firstMessage）
- attach：`pi --session <path>`（resolveSessionPath 支持文件路径）

### 嵌套

子实例是完整 pi（加载全局扩展），天然可再 spawn；不注入 depth、不设 max_depth；agent_id 用随机 UUID 全局唯一。

## 开发约束

- 所有 UI 渲染使用 pi 原生组件（`Text`、`Container`、`setWidget`、`registerMessageRenderer`），不引入第三方 UI 库。
- 参数枚举用 `StringEnum`（Gemini 兼容）。

## 测试决策

- 纯函数全面单测：`protocol.ts`（序列化/解析）、`model.ts`（模型解析）。
- 状态化语义经 seam 测试：`agent-process.ts` 通过 `createClient` 注入 fake，确定性驱动状态机（完成 / wrap-up / 硬中止 / API 错误 / stop / onDelta）。
- 基础设施不测：真实 spawn / rpc 传输（依赖外部进程），以 E2E 冒烟验证（`pi -p` 真实调用）。

## 不在此范围

- **预定义 agent 类型系统**：不定义预设 agent 人格/类型文件；agent 由调用者参数完全定义。
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
