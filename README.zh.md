# pi-subagent

[English](README.md) | [中文](README.zh.md)

从 pi 启动隔离的 sub-agent。每个 sub-agent 都是一个完整 pi 实例、拥有独立上下文——主对话保持干净。

```
你： 调研一下这个项目的数据库 schema
  → pi 调用 Agent，spawn 一个常驻的 `pi --mode rpc` 子进程
  → 子 agent 在独立上下文窗口里独立工作
  → 结果返回；你继续聊天
```

## 为什么需要它？

Pi 没有内置 sub-agent。当一个任务会产生大量中间输出（搜索结果、日志、测试输出）污染你的上下文，或者你想并行跑独立任务而不阻塞主对话时——这就是本扩展的用武之地。

## 安装

```bash
# npm（推荐）
pi install npm:@everyx/pi-subagent

# git
pi install git:github.com/everyx/pi-subagent
```

开发期软链接：

```bash
ln -sf /path/to/pi-subagent ~/.pi/agent/extensions/subagent
```

重启 pi 后直接说"让子 agent 去…"。

## 工具

两个最小原语：

- **`Agent`** — spawn 一个隔离的 sub-agent：`{ prompt, title, model?, thinking?, tools?, run_in_background? }`。`title`（3-5 词，**必填**）作为工具头、通知卡片、widget 行和会话名的标识——对齐 Claude Code 的 `description` / Codex 的 `task_name`。前台（默认）阻塞到结果就绪；`run_in_background: true` 立即返回 `agent_id`，完成时投递携带最终输出的通知。
- **`AgentControl`** — 干预运行中的后台 agent：`steer`（注入重定向消息）或 `stop`（终止）。

LLM 通过 `promptSnippet` + `promptGuidelines`（系统提示注入）获得使用指南：何时委派、prompt 必须自包含、绝不轮询、汇报前验证子 agent 的实际改动。

## 用法

### 发起一个任务

对 pi 说：

```
让一个子 agent 分析 src/ 下的认证逻辑
```

Pi 调用 `Agent`（前台），子 agent 隔离运行，结果返回。

### 后台并行跑多个

```
同时起三个子 agent 分别看 auth 模块、数据库层和 API 路由
```

Pi 调用三次 `Agent`（`run_in_background: true`）。每个完成通知携带对应 agent 的最终输出——无需轮询、无需额外的取结果工具。

### 干预运行中的 agent

```
那个数据层子 agent——方案行不通，改用组合式重写
```

Pi 调用 `AgentControl` 的 `steer` 重定向运行中的 agent。要停掉失控的 agent："干掉那个后台子 agent" → `stop`。

## 进阶

### 指定模型

```
用 claude-sonnet 起一个子 agent 分析数据库设计
```

不指定模型 → 继承当前会话模型。指定但注册表中找不到 → 报错，不静默降级。`thinking` 同理：省略时继承当前推理强度，传 `"off"`…`"max"` 可覆盖。

### 限制工具

```
让子 agent 调研项目结构，但只允许用 read 和 grep
```

子 agent 看不到其他任何工具。只读探索 + 便宜模型是调研任务的推荐模式。

## 可观测性

- **前台** — sub-agent 的输出逐字流式进入工具卡片（rpc `text_delta` 事件转发到 `onUpdate`）。
- **后台** — 编辑器上方常驻状态 widget：`Agents` 标题下每个运行中的 agent 一行 `⠋ <标题> · 42s`（accent spinner + muted 文本，与 pi 内置 working 指示器同一视觉语言），下方追加**最新活动摘录行**（与标题左对齐）：工具调用（`bash: sleep 20`，工具名高亮）、`Thinking...`（斜体，pi 隐藏 thinking 同款）、或最新正文尾部。纯状态设计（无完整输出流——最终结果由完成通知携带，复盘走 `pi --session <path>`）。最后一个 agent 结束后 widget 自动清除。
- **完成通知** — 以 Agent 家族风格渲染卡片：`Agent ✓ <标题> (Took 12.3s · 1,250 tokens · 3 tool uses)` + 结果预览 body + session 路径 footer（状态词仅在失败时显示）。

## 工作原理

每个 sub-agent 都是带持久化 session 的常驻 `pi --mode rpc` 子进程：

- **前台** — `Agent` 等待子进程 settled，取最终输出，然后关闭 stdin（优雅退出）。
- **后台** — `Agent` 立即返回；`agent_settled` 时扩展投递 `subagent-notification`（JSON 内容给 LLM、渲染卡片给用户），子进程优雅退出。
- **Steer/stop** — `AgentControl.steer` 向子进程 stdin 写 `steer` 命令（在当前 turn settled 后投递）；`stop` 关闭 stdin 优雅退出。
- **Attach / 复盘** — sub-agent 会话存储在 `<agent 目录>/subagent-sessions/`（默认 `~/.pi/agent/subagent-sessions/`；可用 `PI_SUBAGENT_SESSION_DIR` 覆盖，agent 目录同样尊重 `PI_CODING_AGENT_DIR`，与 pi 一致），刻意放在 pi 标准会话树**之外**，让 `pi -r` 保持干净。**永不删除**。要 resume/复盘：在主会话里找到 session 路径（Agent 调用结果或完成通知卡片），执行 `pi --session <path>`——通知里也带 path，直接问 LLM 也行。
- **Graceful turn limits** — 每轮 settled 后检查 token 用量：超过 wrap-up 阈值时 steer "尽快总结"消息；超过硬限制（或总超时）时 abort → 等 settled → 优雅退出。不会因突然 SIGTERM 截断输出。

## 嵌套 sub-agent

Sub-agent 是完整 pi 实例，若你全局安装了本扩展，它天然能再 spawn sub-agent——嵌套开箱即用，不做深度控制。每一层都是独立进程、独立上下文，嵌套深度会倍增启动时间和 token 成本。是否值得嵌套由你（或模型）判断。

## 成本与注意

- **Headless（`pi -p`）下后台 agent 随主进程退出。** 主 agent 响应结束即进程退出，后台子 agent 通过 stdin EOF 被清理（不会泄漏为孤儿进程）。后台工作流（等通知、steer、stop）是为常驻的 TUI 会话设计的。
- **一 agent 一进程。** 前台和后台都是常驻 rpc 子进程。后台开多了 = 进程开多了——请节制。
- **通知一次性投递。** 后台结果只投递一次；若投递前主会话崩溃，结果只存在于 session 文件（用 `pi --session <id>` attach 恢复）。
- **Steer 需要活的 agent。** `AgentControl` 只在 agent 运行中（完成通知之前）有效。

## 清理

pi 退出时，运行中的 sub-agent 收到优雅的 stdin-EOF 关闭。session 保留在磁盘供 attach/复盘；不 kill、不删除。

## 开发

```bash
pnpm install
pnpm check      # biome
pnpm typecheck  # tsc --noEmit
pnpm test       # node:test
```

结构：

```
index.ts         — 工具注册（Agent / AgentControl）、通知、清理
protocol.ts      — 纯函数 JSONL 协议层（单测）
rpc-client.ts    — 状态化薄 JSONL 客户端（spawn + 传输）
agent-process.ts — AgentProcess：常驻 rpc 子进程语义封装（经 seam 测试）
model.ts         — 模型解析（测试）
render.ts        — TUI 渲染 + 通知卡片渲染器
widget.ts        — Agents 状态 widget（setWidget，编辑器上方）
```
