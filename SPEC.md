# pi-subagent 规格说明

## 问题陈述

Pi 不支持内置子 agent。官方推荐的 `pi --print` 模式存在不足：

- **不可迭代**：主 agent 看到输出后无法发送后续提示。
- **不可观测**：子 agent 是黑盒运行，无法查看中间状态或跳入。
- **不可清理**：悬挂的 tmux 会话和进程缺乏协调清理机制。

生态中的其他 skill 需要一个标准的 `subagent` 工具来委托工作。

> **并行**由 pi 原生支持：LLM 一次响应中发出多个 tool call 时，pi 并发执行所有调用。subagent 不内置自己的并行机制。

## 解决方案

一个 pi 扩展，注册 `subagent` 工具，支持三种模式：

- **非交互**（默认）：`spawn` + `pi --print --no-session`，零 tmux 开销。
- **交互**（`interactive: true`）：命名 tmux 会话（`pi-sub-<id>`），可 `tmux attach`。
- **Battle**（`session + task`）：`tmux paste-buffer` 向运行中的子 agent 发后续提示，结果通过 Unix socket 推回。

## 设计原则

### Pi Native
用户使用本插件的感觉应与使用 pi 内置工具一致统一：

- **一致的调用方式**：参数 schema、命名风格与 pi 内置工具（`bash`、`read`、`edit` 等）保持一致。
- **一致的输出质感**：渲染复用 pi 原生 TUI 组件（`Box`、`Text`、`Spacer`），排版、颜色、交互反馈与内置工具一致。
- **一致的行为体感**：错误处理、进度反馈、清理逻辑等遵循 pi 生态惯例。
- **依赖原生能力**：多 task 并行由 pi 的 tool call 批量执行机制实现，subagent 不内置聚合逻辑。

### LLM Friendly
LLM 上下文窗口是宝贵资源。

- **Token Economy**：返回给 LLM 的 `content` 仅包含完成任务所需的最小信息——子 agent 的输出文本。装饰性元素（状态标记、emoji、计时、原始 prompt）仅在 TUI 渲染中呈现，不出现在 LLM 可见的文本中。

### 提供能力而非方案

提供原语，让用户组合。组合逻辑在调用者的 prompt 里，不在工具层。
不封装工作流模板、不自动重试、不做结果后处理。

## 用户故事

1. 委托子 agent 研究问题，不污染主会话上下文窗口，输出纯文本直接可用。
2. 简单任务默认非交互模式（零 tmux 开销）；复杂任务切交互模式通过 session 名 `tmux attach` 观测。
3. 向运行中的交互式子 agent 发送后续提示，在不丢失上下文的情况下迭代讨论。
4. 同时调用多个 subagent 探索独立问题——LLM 发出多次 tool call，pi 原生并发执行，结果各自返回。
5. 父级退出时自动清理子 agent 会话，支持确认保留或通过工具提前关闭。
6. 为每个子 agent 独立覆盖模型和工具白名单（如廉价模型做侦察，强模型做实现）。
7. skill 开发者依赖稳定的 `subagent` 工具 API 和参数 schema。
8. Ctrl+C 终止执行中的子 agent，取消耗时或错误的子任务。
9. 扩展零额外 npm 依赖（仅依赖 pi 已打包的 packages）。

## UI 设计

### 渲染状态

`renderCall` 展示 header（工具名 + task + 可选的 model/session），`renderResult` 追加 body + timer。header 由 renderCall 独占，renderResult 不自含 header。

### 执行中（renderCall）

```
subagent ⚡ 认证扫描
```

- `subagent` 以 header 样式渲染
- ⚡ 非交互 / 💬 交互
- 任务描述（`args.task`）
- model 和 session 初始时不显示，renderResult 写入 state 后在下一个 timer tick 可见

### 完成（renderResult）

```
> 查找项目中所有认证相关的代码...
正在扫描 src/ 目录下的认证逻辑...

Took 1.2s
```

- header 由 renderCall 独占，renderResult 仅展示 body + timer
- 主体内容：样式同 bash output。prompt 行以 `>` 前缀开头，紧接 output 内容，之间无空行
- 空一行（`\n`）分隔主体和底部
- 底部：`Took X.Xs`（muted 色，精确到 0.1s）
- 进行中 timer 跳动时 label 为 `Elapsed`，完成后定格为 `Took`
- 背景色由 pi 框架根据执行状态自动切换

### Battle 模式

```
> 继续深入分析认证模块...
分析结果：...

Took 0.8s
```

- header 在 renderCall 中显示 session 名（继承自原 session）
- 模型继承自原 session，无降级 warning
- 布局与单任务一致

### Close 模式

```
subagent ✕ close pi-sub-a1b
Closed sub‑agent session pi-sub-a1b
```

- renderCall：`subagent ✕ close <session>`
- renderResult：dim 样式确认文本
- 无 timer、无主体内容

### 背景色与状态

| 状态 | 背景色 | 说明 |
|------|--------|------|
| 执行中 | 默认 pending 色 | renderCall 渲染中，还没有 result |
| 完成（成功） | 默认 success 色 | 最终 renderResult |
| 错误 | 默认 error 色 | `result.isError === true` |

背景色由 pi 框架根据 `isPartial` 和 `isError` 自动切换，subagent 的 `renderResult` 不需要关心背景色逻辑。

## 实现决策

### 架构

编排层与执行后端分离，使不同执行环境（spawn / tmux）可互换而不影响工具注册逻辑。

### 通信协议

Unix socket + 长度前缀帧。短连接，每轮新连接写一个包即断开。

### tmux 生命周期

| | 非交互模式 | 交互模式 |
|---|---|---|
| tmux 会话 | 不创建 | `pi-sub-<random>` |
| pi 调用 | `pi --print --no-session`（spawn） | tmux shell 脚本（`pi -n`） |
| 结果捕获 | stdout 管道 | Unix socket |
| Battle | ❌ | ✅ `tmux paste-buffer` + socket |
| 退出清理 | 不适用 | 确认提示（TUI）或静默杀死（headless） |

### 工具参数 schema

```typescript
{ task: string, model?: string, tools?: string[], interactive?: boolean }

// Battle（向运行中的 session 发后续 prompt）
{ session: string, task: string }

// 关闭 session
{ session: string, close: true }
```

### Model 解析

- 未指定 → 使用父会话模型（`ctx.model`），不经过 registry。
- 指定 → 匹配 registry（支持 `provider/name` 或 `name` 简写），找不到则降级父模型 + warning。

### 父级退出时的清理

父级退出时自动触发清理。TUI 模式展示活跃会话确认对话框，headless 模式静默杀死。临时目录一并清理。

## 开发约束

### 使用原生组件
所有 UI 渲染使用 pi 的原生组件（`Spacer`、`Box`、`Text` 等），不引入第三方 UI 库。



## 测试决策

只测协议 seam（长度前缀 socket 往返），不测基础设施编排。

pi mono 仓库不为其扩展提供测试，本仓库遵循相同约定。

## 不在此范围

- **Agent 定义文件**：不定义预设 agent 人格。Agent 由调用者参数完全定义。
- **Windows 支持**：Unix socket + tmux 仅限 Linux/macOS。
- **持久化会话**：会话临时，父级退出即清理，不序列化。
- **守护进程**：子 agent 始终在 pi 进程中运行。
- **并行聚合**：多 task 由 LLM 多次 tool call 驱动，subagent 不提供 `tasks[]` 聚合参数。

## 其它说明

- 扩展必须支持子模式自动加载（`~/.pi/agent/extensions/` 或 `pi install`），子 pi 实例启动时自动激活子模式行为。
