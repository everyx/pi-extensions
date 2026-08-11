# pi-subagent

[English](README.md) | [中文](README.zh.md)

**Pi 的极简子代理——三原语、无噪音、无限制。**

```
你： 调研一下这个项目的数据库 schema
  → pi 调用 agent_spawn，spawn 一个常驻的 `pi --mode rpc` 子进程
  → 子 agent 在独立上下文窗口里独立工作
  → 结果返回；你继续聊天
```

## 为什么需要它？

Pi 没有内置 sub-agent。于是重活、并行的活、吃上下文的活，全都挤进你那一个窗口。pi-subagent 把活交给子 pi：噪音留在那边，只有答案回来。

## 特性

- **安静上下文** — 日志、搜索结果、测试输出留在子窗口里。你拿到最终结果，不是一片杂乱。
- **真正并行** — 一次起多个后台 agent，各自完成时投递自己的通知。无队列、无取结果工具。
- **全程可控** — `agent_send` 给运行中的 agent 发消息重定向（也能唤醒空闲的），`agent_stop` 终止。子 agent 发往父会话的消息是尽力投递（无确认）。
- **按需常驻** — `agent_spawn(persistent: true)` 后，子 agent 完成后进程驻留 idle（零 token）；之后随时 `agent_send` 唤醒、在同一上下文继续追问，或 `agent_stop` 结束。
- **Pi 原生** — 渲染、会话、attach 全复用 pi 自己的机制；卡片看起来像内置工具——因为它们就是。
- **继承或覆盖** — 子 agent 默认继承你的模型与推理强度，也可逐个覆盖。便宜模型做侦察，强模型做实现。
- **无隐藏限制** — 默认无 token 上限、无超时、无并发上限。需要时用可选 `timeoutMs` 加一道护栏。
- **可复盘** — 每个会话持久化、永不删除；任何结果都能 `pi --session <path>` 回看。
- **零依赖 + 可嵌套** — 仅 peerDependencies。子 agent 是完整 pi 实例，天然能再 spawn 孙 agent。
- **Token 经济** — 系统侧保持克制：
  - **系统提示** — 三个工具 + 简短指南，注入约 2–3KB 系统提示（token 数随 tokenizer 略有出入）。
  - **通知** — LLM 只看到最小结构化数据；装饰（title、用量、会话路径）留在渲染层，永不进入 LLM 上下文。
  - **结果** — 自动截尾（2000 行 / 50KB）；展开任何卡片仍见全量。

## 与同类插件的对比

pi-subagent 与 [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)、[`pi-subagents`](https://github.com/nicobailon/pi-subagents) 都能为 pi 提供隔离并行的子 agent。它们落在 *原语 → 框架* 的光谱上，pi-subagent 刻意站在最极简的**原语**这一端：三个原语、无预定义角色、无框架——组合由你。具体能力见[特性](#特性)；取舍落在哪里，见下表与两个最流行的同类插件对照。

| | **pi-subagent** | **@tintinweb/pi-subagents** | **pi-subagents (nicobailon)** |
|---|---|---|---|
| 设计姿态 | 最小原语 | 全功能框架 | 全功能框架 |
| 工具面 | `agent_spawn` / `agent_stop` / `agent_send`（3 个） | Claude Code 风格 `Agent` / `get_subagent_result` / `steer_subagent` | `subagent` + 管理/状态/控制工具族 |
| 预定义角色 | 无——由 prompt 定义 | 自定义类型 `.pi/agents/*.md`（frontmatter） | 8 个内置（scout / reviewer / worker / oracle…） |
| 并行 | 无并发上限（一 agent 一进程） | 队列，默认并发 4 | 有 spawn / turn / usage budget |
| 默认限制 | 无（可选 `timeoutMs`） | graceful turn limits | turn / usage budget |
| 可观测性 | pi 原生卡片 + widget + `pi --session` | FleetView + conversation viewer | FleetView inspector + fleet |
| 嵌套 | 天然、无深度上限 | opt‑in、有深度上限 | recursion guard |
| 附加能力 | token 经济、零运行时依赖、reload/崩溃零孤儿 | memory、worktree 隔离、定时任务、跨扩展 RPC、事件总线 | missions/定时、watchdog、worktree、intercom、chain 编排 |
| 适合 | 自己掌控组合 | 开箱即用的完整子 agent 系统 | 内置角色 + 工作流编排 |

## 安装

```bash
# npm（推荐）
pi install npm:@everyx/pi-subagent

# git
pi install git:github.com/everyx/pi-subagent
```

开发期软链接：

```bash
ln -sf /path/to/pi-extensions/packages/pi-subagent ~/.pi/agent/extensions/subagent
```

重启 pi 后直接说"让子 agent 去…"。

## 快速上手

### 发起一个任务

```
让一个子 agent 分析 src/ 下的认证逻辑
```

Pi 调用 `agent_spawn`（前台），子 agent 隔离运行，结果内联返回。

### 后台并行跑多个

```
同时起三个子 agent 分别看 auth 模块、数据库层和 API 路由
```

Pi 调用三次 `agent_spawn`（`run_in_background: true`）。每个完成通知携带对应 agent 的最终输出——无需轮询、无需额外的取结果工具。

### 发消息或停止

```
那个数据层子 agent——方案行不通，改用组合式重写
```

Pi 调用 `agent_send` 向运行中的 agent 注入重定向消息（当前 turn 结束后送达）。要停掉失控的 agent：“干掉那个后台子 agent” → `agent_stop`。两者对运行中的 agent 都适用；`persistent: true` 的话，完成后依然可寻址——`agent_send` 唤醒空闲的 agent 继续追问，`agent_stop` 结束。

## 配置

### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PI_SUBAGENT_SESSION_DIR` | `<agentDir>/subagent-sessions/` | 子 agent 会话存放目录；设置可迁移位置。`<agentDir>` 为 pi 的 agent 目录（默认 `~/.pi/agent`，遵循 pi 的 `PI_CODING_AGENT_DIR`）。 |

目录遵循 pi 的 agent-dir 约定，刻意放在 pi 标准会话树之外，让 `pi -r`（resume）保持干净。会话文件永不删除。

### 工具参考

#### `agent_spawn` — spawn 一个隔离的 sub-agent

| 参数 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `prompt` | string | **必填** | 子 agent 的自包含任务描述。 |
| `title` | string（3-5 词） | **必填** | 作为工具卡、通知卡、widget 行和会话名的标识——对齐 Claude Code 的 `description` / Codex 的 `task_name`。 |
| `model` | string | 继承 | 覆盖子 agent 的模型。指定但注册表中找不到 → **报错，不静默降级**。 |
| `thinking` | `"off"`…`"max"` | 继承 | 覆盖推理强度；省略则用当前会话的级别。 |
| `tools` | string[] | 全部 | 子 agent 可见的工具白名单——白名单之外全部不可见。 |
| `run_in_background` | boolean | `false` | 前台（默认）阻塞到结果就绪；`true` 立即返回 `agent_id`，完成时投递携带最终输出的通知。 |
| `timeoutMs` | number | 无 | 可选截止时间（毫秒）。触发时扩展停止子进程、等其 settled 后优雅退出。 |
| `persistent` | boolean | `false` | 完成后进程驻留 idle（零 token）而非退出；之后 `agent_send` 可唤醒继续同一上下文，`agent_stop` 结束。前台/后台都支持。 |

#### `agent_stop` — 终止一个 agent

| 参数 | 含义 |
|---|---|
| `agent_id` | **必填** — `agent_spawn` 返回的 agent id。运行中或 idle（persistent）的 agent 都适用。优雅终止（stdin EOF → 优雅退出）；不投递完成通知。 |

#### `agent_send` — 树内发消息

| 参数 | 含义 |
|---|---|
| `to` | **必填** — 树路径 id（`"a2"`，孙 agent 用 `"a1/a1-1"`），或 `"@parent"` 发给父会话。 |
| `message` | **必填** — 消息文本；目标当前 turn 结束后送达，idle 的 persistent agent 会被唤醒。 |

消息沿树的父子边路由：直接子 agent 下投，`@parent` 上抛，跨层/兄弟消息经途经的父 LLM 上下文中转（见[嵌套 sub-agent](#嵌套-sub-agent)）。

LLM 通过 `promptSnippet` + `promptGuidelines`（系统提示注入）获得使用指南：何时委派、prompt 必须自包含、绝不轮询。

## 进阶

### 指定模型

```
用 claude-sonnet 起一个子 agent 分析数据库设计
```

不指定模型 → 继承当前会话模型。`thinking` 同理：省略时继承当前推理强度，传 `"off"`…`"max"` 可覆盖。

模型**指定但注册表中找不到** → 报错，不静默降级。

### 限制工具

```
让子 agent 调研项目结构，但只允许用 read 和 grep
```

子 agent 看不到其他任何工具。只读探索 + 便宜模型是调研任务的推荐模式。

## 工作原理

每个 sub-agent 都是带持久化 session 的常驻 `pi --mode rpc` 子进程：

- **前台** — `agent_spawn` 等待子进程 settled，取最终输出，然后关闭 stdin（优雅退出）。
- **后台** — `agent_spawn` 立即返回；`agent_settled` 时扩展投递 `subagent-notification`（JSON 内容给 LLM、渲染卡片给用户），子进程优雅退出。
- **发消息/停止** — `agent_send` 向子进程 stdin 投递消息（运行中入队，当前 turn settled 后送达）；`agent_stop` 关闭 stdin 优雅退出。两者对运行中的 agent 都适用。
- **Persistent idle** — `persistent: true` 时子进程完成后驻留 idle（零 token）；之后 `agent_send` 可唤醒继续同一上下文，`agent_stop` 结束。完成通知与 widget 行带 `idle` 标记。
- **Attach / 复盘** — sub-agent 会话存储在 `<agent 目录>/subagent-sessions/`（见[配置](#配置)）。在主会话里找到 session 路径（agent_spawn 调用结果或完成通知卡片），执行 `pi --session <path>`——通知里也带 path，直接问 LLM 也行。
- **Graceful turn limits（默认不限，opt-in）** — 不设隐藏 deadline：子 agent 一直跑到完成或被停，除非你传 `timeoutMs`。不做 token 限制——用量仅通知卡统计。

## 嵌套 sub-agent

子 agent 是完整 pi 实例——全局安装本扩展后，它天然能再 spawn 子 agent。每一层都是独立进程、独立上下文；深度倍增启动时间与 token 成本。是否值得，由你（或模型）判断。

树就是地址空间：每个子 agent 获得树路径 id（`a2`、`a1/a1-1`…），`agent_send` 沿父子边路由。子 agent 也能用 `"@parent"` 向上发消息——比如遇到缺信息/需决策的阻塞时向父会话求助——父的回复接着它的上下文继续。跨层与兄弟消息经途经的父 LLM 上下文中转，这是树状协调的固有代价。

## 成本与注意

- **Headless 下子 agent 随宿主退出**（`pi -p`）。主进程在响应结束时退出，后台子 agent 经 stdin EOF 被清理——从不留孤儿。后台流程（等通知、发消息、stop）面向常驻的 TUI 会话。
- **一子 agent 一进程。** 前台后台同是常驻 rpc 子进程。开多了 = 进程多了——请节制。
- **结果一次性投递。** 后台结果只投一次；若主会话先崩，结果还在 session 文件里（`pi --session <path>`）。
- **发消息/停止需要可寻址的子 agent。** `agent_send` 与 `agent_stop` 指向运行中的子 agent——`persistent` spawn 的话，完成后驻留的 idle 子 agent 同样可寻址。非 persistent 的子 agent 在完成通知投递后就没了，对它发消息/停止会报错。

## 清理

pi 退出时，子 agent（运行中或 idle）都收到优雅的 stdin-EOF 关闭。session 留在磁盘供 attach/复盘——不杀进程、不删文件。
