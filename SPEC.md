# pi-subagent 规格说明

## 问题陈述

Pi 本身不提供内置的子 agent 功能——这是作者在博客文章中明确的设计选择。官方推荐的模式（通过 bash 调用 `pi --print`）可以处理一次性委托，但存在以下不足：

- **程序化 battle**：主 agent 在看到子 agent 的输出后无法发送后续提示，无法进行迭代式讨论。
- **可附加性**：非交互式子 agent（`pi --print`）是黑盒运行，用户无法查看中间状态或跳入对话。
- **并行性**：同时运行多个子 agent 需要手动编排。
- **生命周期管理**：悬挂的子 agent 进程和 tmux 会话会累积造成混乱，缺乏协调清理机制。

生态中的其他 skill（如 wayfinder 的 "Fire the research subagents"）需要一个标准的 `subagent` 工具来委托工作，但目前没有这样的工具存在。

## 解决方案

一个 pi 扩展，注册一个可供 LLM 调用的 `subagent` 工具。该工具支持：

- **非交互模式**（默认）：通过 `spawn` 调用 `pi --print --no-session` 并捕获 stdout。零开销，无需 tmux。
- **交互模式**（`interactive: true`）：在命名的 tmux 会话（`pi-sub-<id>`）中启动完整的 pi 会话。用户可以随时 `tmux attach -t pi-sub-<id>`。
- **Battle 模式**（`session: "pi-sub-xxx" + task`）：父级通过 `tmux paste-buffer` 向正在运行的交互式子 agent 发送后续提示。子 agent 的子模式扩展监听 `agent_settled` 事件，并通过 Unix socket 将结果推回。
- **并行模式**（`tasks[]`）：通过 `Promise.all` 并发运行多个子 agent 并聚合其结果。

同一个扩展二进制文件同时扮演父级和子级角色：子级在启动时检测 `PI_SUBAGENT_PARENT_SOCKET` 并激活 `agent_settled` 监听器（子模式下不注册工具）。

## 用户故事

1. 作为 pi 用户，我想将研究任务委托给子 agent，不污染主会话的上下文窗口，让主 agent 专注于当前任务。
2. 作为 pi 用户，我希望子 agent 默认以非交互模式运行，对于简单的一次性任务不必承担 tmux 开销。
3. 作为 pi 用户，当预计需要检查或跳入子 agent 会话时，我希望设置为交互模式以获得完全的可观测性。
4. 作为 pi 用户，我希望工具在交互模式下显示 tmux 会话名称（`pi-sub-xxx`），以便立刻 `tmux attach`。
5. 作为 pi 用户，在看到第一个结果后，我想向正在运行的交互式子 agent 发送后续提示，从而在不丢失上下文的情况下迭代答案。
6. 作为 pi 用户，我想并行运行多个子 agent，以便同时探索独立问题（例如"查找所有认证代码"+"查找所有数据库模式"）。
7. 作为 pi 用户，我希望并行子 agent 的结果聚合为单个响应，并带有清晰的分节标题，以便一目了然地浏览。
8. 作为 pi 用户，我希望父 pi 退出时清理子 agent 会话，避免悬挂的 tmux 会话累积。
9. 作为 pi 用户，我希望在交互模式下杀死残留子 agent 前有确认提示，以便选择保留它们供后续重新附加。
10. 作为 pi 用户，我想通过工具提前关闭特定的子 agent 会话，以便在不再需要时释放资源。
11. 作为 pi 用户，我想为每个子 agent 覆盖模型和工具白名单，以便用廉价模型（Haiku）做侦察，用强大模型（Sonnet）做实现。
12. 作为 skill 开发者，我想要一个参数 schema 稳定的 `subagent` 工具，以便我的 skill 可以编程式调用它（例如 wayfinder 的 "Fire the research subagents"）。
13. 作为 pi 用户，我希望子 agent 的输出以纯文本返回（不是文件引用或结构化 JSON），主 agent 无需额外解析即可直接使用。
14. 作为 pi 用户，我希望通过 Ctrl+C 终止子 agent 执行，以便取消耗时或错误的子任务。
15. 作为 pi 用户，我希望扩展除了 pi 已打包的依赖（`typebox`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`）外无需额外 npm 依赖，安装简便。

## 实现决策

### 架构

扩展（`index.ts`）是单个文件，通过环境变量控制两种工作模式：

```
父模式（无环境变量）：
  → 注册 `subagent` 工具
  → 管理 tmux 会话、socket 服务器、子进程生命周期

子模式（设置了 PI_SUBAGENT_PARENT_SOCKET）：
  → 钩住 `agent_settled`，通过 Unix socket 推送最后一条助手输出
  → **不**注册工具（避免与父级工具冲突）
```

### 通信协议（子 → 父）

采用长度前缀帧格式的 Unix socket：

```
[4 字节：大端 uint32 长度][UTF-8 文本字节]
```

载荷格式为 `sessionName\0text`（sessionName 可为空）。

子级连接、写入一个包、断开。每轮使用新连接。

服务器端是模块级共享的持久 server（`ensureSharedServer`），通过 `sessionName` 路由消息。共享 server 在扩展卸载时关闭。

### tmux 生命周期

| | 非交互模式 | 交互模式 |
|---|---|---|
| tmux 会话 | 不创建 | `pi-sub-<random>` |
| pi 调用 | `pi --print --no-session "..."`（通过 `spawn`） | `pi -n pi-sub-xxx --name sub-xxx 'task'`（通过 tmux 中的 shell 脚本） |
| 结果捕获 | stdout 管道 | Unix socket（子级在 `agent_settled` 时推送） |
| Battle 支持 | ❌ | ✅ `tmux paste-buffer` + socket |
| 父级退出时的清理 | 不适用（无 tmux） | 确认提示（交互模式）或静默杀死（headless 模式） |

### tmux 脚本的 shell 引号

任务被嵌入为单引号 shell 参数。任务中的单引号使用 `'\''` 模式（结束引号、转义引号、恢复引号）进行转义。由 `runInteractive` 内的 `squote()` 辅助函数处理。

### 会话状态

模块级别的 `Map<string, SessionState>` 跟踪活跃的交互式会话：

```typescript
interface SessionState {
  id: string;
  sessionName: string;
}
```

该映射用于 battle 路由、关闭操作和 `session_shutdown` 时的清理。

Socket 服务器是模块级的共享实例（`ensureSharedServer`），不在 SessionState 中持有。

### 并行执行

对任务数组使用 `Promise.all`。每个任务独立运行——并发子 agent 之间没有共享的可变状态（每个子 agent 获得唯一的会话名称、socket 路径和 tmux 会话）。

显示列表在开始时预填充（所有任务 `[ ]` 状态）。任务执行时，显示列表逐个更新。Print 模式通过 `onChunk` 流式推送累积输出，任务之间 `setTimeout(10)` 让 TUI 有机会渲染部分状态。每个任务的数据包含 `id`、`output`、`sessionName`、`prompt`（原始提示词）和 `model`，确保渲染层能完整展示。

### 工具参数 schema

```typescript
// 任务配置（用于 tasks[] 中）
{ id?: string, task: string, model?: string, tools?: string, interactive?: boolean }

// 单任务/并行模式（tasks[] 为唯一入口）
{ tasks: TaskConfig[] }

// Battle 模式
{ session: string, task: string }

// 关闭模式
{ session: string, close: true }
```

`tasks[]` 是执行子 agent 的唯一入口。传**一个元素**即单任务，传**多个元素**即并行执行。`interactive`、`model`、`tools` 在每个 `TaskConfig` 中独立设置，不使用顶层快捷参数。

### Model 解析

用户可通过 `model` 参数覆盖子 agent 的模型：

- **未指定**时直接使用父会话的模型（`ctx.model`），不经过 registry 匹配。
- **指定**时走 `resolveModel`：标准化（`toLowerCase` + `[._:]` → `-`）后做 substring `includes` 匹配，支持 `provider/name` 或 `name` 简写。
- 如果指定但 registry 中找不到，降级到父会话模型并附加 `warning`。
- 单任务模式正确传递 `warning`；并行模式（当前实现）静默丢弃 `warning`。

### 父级退出时的清理

`session_shutdown` 事件（在 Ctrl+C、Ctrl+D、SIGHUP、SIGTERM 时触发）。交互（TUI）模式显示一个列出活跃会话的确认对话框。Headless 模式静默杀死。临时目录（`/tmp/pi-subagent-*`）在退出时清理。

## 测试决策

### 什么构成好的测试

测试协议，而非基础设施。核心的新颖逻辑是子级和父级之间通信使用的 Unix socket 长度前缀帧。其余部分（tmux 编排、pi 子进程启动）是对系统工具的精简包装，更适合通过手动集成测试来验证。

### 被测模块

- **Socket 协议**：`readLengthPrefixed` / `writeLengthPrefixed` 函数（长度前缀帧的读取和写入），以及对应的 `ensureSharedServer` + 按 `sessionName` 路由模式。

### 测试方法

单一的测试 seam：**长度前缀 socket 往返**。创建服务器，连接客户端，写入带有 4 字节头 + UTF-8 载荷的消息，验证服务器正确读取。测试边界情况：

- 空消息
- 多字节 UTF-8 字符
- 大消息（接近超时边界）
- 在写入前断开客户端
- Abort 信号取消读取

### 先例

pi mono 仓库不为其扩展示例提供测试。本仓库遵循相同的约定——扩展在日常使用中测试，而非在 CI 中。

## 不在此范围

- **Agent 定义文件**（`~/.pi/agent/agents/*.md`）：初始实现不定义或发现预设的 agent 人格。Agent 完全由调用者传递的参数（`task`、`model`、`tools`）定义。希望使用可重用配置的用户可以使用 pi 现有的 Prompt Templates。
- **并发限制**：`Promise.all` 不加限制地运行所有任务。如果过多并行子 agent 导致资源压力，可以后续添加并发限制。
- **Windows 支持**：Unix socket 和 tmux 仅限 Linux/macOS。此版本不支持 Windows。
- **结构化输出解析**：子级返回原始助手文本。没有 JSON schema 强制或结构化提取。
- **跨父级重启的持久化子 agent 会话**：会话是临时的，在父级退出时清理。无会话序列化。
- **后台守护进程模式**：子 agent 始终在 pi 进程中运行。没有 headless 长期运行的守护进程。

## 其它说明

- 扩展必须在子模式下自动加载（即安装在 `~/.pi/agent/extensions/` 或通过 `pi install` 安装），这样子 pi 实例能自动检测 `PI_SUBAGENT_PARENT_SOCKET` 并激活 `agent_settled` 监听器。
- 工具的 `renderCall` 显示 `subagent (0/N)` 头（`N` 为任务总数），无 task 条目，避免与 renderResult 重复。各模式的 header 格式：
  - tasks：`subagent (0/N)`
  - battle：`subagent battle <session>`
  - close：`subagent ✕ close <session>`
  - 默认：`subagent`
- 并行模式的 execute 同时返回两种格式：`content` 中的扁平文本给 LLM 阅读（`- [x] ⚡ **task** \`\`\`...\`\`\``），`details.tasks` 给 TUI 做渲染。
- 并行模式的 `renderResult` 渲染为扁平任务列表（无头部重复），每个任务包含：状态 checkbox（`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成，颜色覆盖 `-` 和 task 名）、模式 emoji（`⚡` 非交互 / `💬` 交互）、模型和 session 信息，prompt（换行拍平成单行），输出（`dim` 风格，每个任务独立使用 `truncateToVisualLines(5)` + `keyHint` 展开提示），结束后显示耗时。
- 任务之间的间距使用 `Spacer(1)` 组件。
- Battle 模式的 renderCall 显示 `subagent battle <session>`，renderResult 显示 session 名称和输出。
- 单任务（`tasks: [{ task: "..." }]`）的 renderResult 与并行模式使用同一套渲染逻辑，只是列表只有一项。
- Battle 模式通过 `tmux paste-buffer` 发送后续提示，将文本键入终端输入。这能在 pi 的编辑器中工作，但假设编辑器为空并等待输入。不发送 `Ctrl+C` 清除（在大多数终端编辑器中，tmux paste-buffer 会替换当前行）。
