# pi-subagent 规格说明

## 问题陈述

Pi 不支持内置子 agent。官方推荐的 `pi --print` 模式存在不足：

- **不可迭代**：主 agent 看到输出后无法发送后续提示。
- **不可观测**：子 agent 是黑盒运行，无法查看中间状态或跳入。
- **不可并行**：同时运行多个子 agent 需手动编排。
- **不可清理**：悬挂的 tmux 会话和进程缺乏协调清理机制。

生态中的其他 skill 需要一个标准的 `subagent` 工具来委托工作。

## 解决方案

一个 pi 扩展，注册 `subagent` 工具，支持四种模式：

- **非交互**（默认）：`spawn` + `pi --print --no-session`，零 tmux 开销。
- **交互**（`interactive: true`）：命名 tmux 会话（`pi-sub-<id>`），可 `tmux attach`。
- **Battle**（`session + task`）：`tmux paste-buffer` 向运行中的子 agent 发后续提示，结果通过 Unix socket 推回。
- **并行**（`tasks[]`）：`Promise.all` 并发运行多个子 agent 并聚合结果。

同一扩展单文件双模式：主 agent 调用时作为父级注册工具；被子 agent 启动的子实例自动感知父级存在并切换为子角色（不注册工具），将输出推回父级。

## 设计原则

### Pi Native
用户使用本插件的感觉应与使用 pi 内置工具一致统一：

- **一致的调用方式**：参数 schema、命名风格与 pi 内置工具（`bash`、`read`、`edit` 等）保持一致。
- **一致的输出质感**：渲染复用 pi 原生 TUI 组件（`Box`、`Text`、`Spacer`），排版、颜色、交互反馈与内置工具一致。
- **一致的行为体感**：错误处理、进度反馈、清理逻辑等遵循 pi 生态惯例。

### LLM Friendly
LLM 上下文窗口是宝贵资源。

- **Token Economy**：返回给 LLM 的 `content` 仅包含完成任务所需的最小信息——任务名和结果输出。装饰性元素（状态标记、emoji、计时、原始 prompt）仅在 TUI 渲染中呈现，不出现在 LLM 可见的文本中。

## 用户故事

1. 委托子 agent 研究问题，不污染主会话上下文窗口，输出纯文本直接可用。
2. 简单任务默认非交互模式（零 tmux 开销）；复杂任务切交互模式通过 session 名 `tmux attach` 观测。
3. 向运行中的交互式子 agent 发送后续提示，在不丢失上下文的情况下迭代讨论。
4. 并行运行多个子 agent 探索独立问题，结果聚合为带清晰分节的单个响应。
5. 父级退出时自动清理子 agent 会话，支持确认保留或通过工具提前关闭。
6. 为每个子 agent 独立覆盖模型和工具白名单（如廉价模型做侦察，强模型做实现）。
7. skill 开发者依赖稳定的 `subagent` 工具 API 和参数 schema。
8. Ctrl+C 终止执行中的子 agent，取消耗时或错误的子任务。
9. 扩展零额外 npm 依赖（仅依赖 pi 已打包的 packages）。

## UI 设计

### 并行 / 单任务模式

```
subagent (0/2)

- [✓] ⚡ 认证扫描 (claude-sonnet-4) | ⏱️ 1.2s
  Model "haiku" not available, using "claude-sonnet-4"
  ... (3 earlier lines, [keyHint])
  > 查找项目中所有认证相关的代码...
  正在扫描 src/ 目录下的认证逻辑...
- [~] 💬 数据库模式 (claude-sonnet-4) | pi-sub-c3d | ⏱️ 2.3s
  > 查找所有数据库表和模式定义...
  发现 3 个表：users, orders, products

Took 4.0s
```

- 状态 checkbox：`[ ]` 未开始 → `[~]` 进行中 → `[✓]` 完成，与 emoji、任务名使用同一 status 颜色。
- 模式 emoji：`⚡` 非交互、`💬` 交互。
- 非交互模式不显示 session 名（`| pi-sub-xxx`），交互模式显示。
- 状态行各字段用 `|` 分隔：`(模型)`、`[| session]`、`| ⏱️ 耗时`。进行中的耗时实时刷新（0.1s 精度），完成后定格。末尾显示所有任务的总耗时。
- 若模型降级，紧接状态行下方以 `model` 色显示 warning 信息，然后跟上 prompt。
- prompt（`>` 开头）与 output 均为 dim 样式，之间无空行，紧接排列。合并为一个可折叠块（`renderExpandableOutput`），折叠时最多 5 行，超出显示 `keyHint`。
- 单任务与并行复用同一套渲染逻辑，仅列表项数量不同。
- `execute` 返回双格式：`content` 给 LLM 阅读（XML：`<result id="...">...output...</result>`），`details.tasks` 给 TUI 渲染（含完整状态信息）。
- LLM 输出采用 XML 而非 markdown 代码块，因为子 agent 的 output 本身可能包含三反引号导致解析歧义。XML tag 提供无歧义的边界。

### Battle 模式

```
subagent

- [~] 💬 深入分析 (claude-sonnet-4) | pi-sub-a1b | ⏱️ 0.8s
  > 继续深入分析认证模块...
  分析结果：...
```

- header 无任务数量（battle 为单步操作，不显示计数）。
- 发送后续提示后立即进入 `[~]` 状态并开始计时，完成后转入 `[✓]`，耗时定格。布局复用任务列表项的风格。
- 通过 `tmux paste-buffer` 将 `>` 后的 prompt 键入子 agent 终端。
- 模型继承自原 session（SessionState.model），在状态行显示。不经过 registry 解析，因此无模型降级 warning。

### Close 模式

```
subagent ✕ close pi-sub-a1b
Closed sub‑agent session pi-sub-a1b
```

- renderCall：`subagent ✕ close <session>`
- renderResult：dim 样式文本

## 实现决策

### 架构

单文件双模式，通过父子通信通道自动识别角色：

- **父模式**：注册 `subagent` 工具，管理子 agent 生命周期。
- **子模式**：在子 pi 实例中运行，将最后一条助手输出推回父级，不注册工具。

父级持有活跃会话注册表和 socket server，子级无状态。

### 通信协议

Unix socket + 长度前缀帧（4 字节大端 uint32 长度 + UTF-8 载荷），载荷格式 `sessionName\0text`。短连接：每轮新连接，写一个包即断开。共享 server 按 sessionName 路由消息，扩展卸载时关闭。

### tmux 生命周期

| | 非交互模式 | 交互模式 |
|---|---|---|
| tmux 会话 | 不创建 | `pi-sub-<random>` |
| pi 调用 | `pi --print --no-session`（spawn） | `pi -n pi-sub-xxx 'task'`（tmux shell 脚本） |
| 结果捕获 | stdout 管道 | Unix socket（`agent_settled` 推送） |
| Battle | ❌ | ✅ `tmux paste-buffer` + socket |
| 退出清理 | 不适用 | 确认提示（TUI）或静默杀死（headless） |

### 工具参数 schema

```typescript
// 执行入口（单任务或并行）
{ tasks: { id?: string, task: string, model?: string, tools?: string, interactive?: boolean }[] }

// Battle
{ session: string, task: string }

// 关闭
{ session: string, close: true }
```

`tasks[]` 是唯一执行入口，传一个元素为单任务，多个为并行。`model`、`tools`、`interactive` 在每个 TaskConfig 中独立设置。

### Model 解析

- 未指定 → 使用父会话模型（`ctx.model`），不经过 registry。
- 指定 → 标准化后 `includes` 匹配 registry（支持 `provider/name` 或 `name` 简写），找不到则降级父模型 + warning。

### 并行执行

`Promise.all` 并发运行，各子 agent 无共享可变状态（唯一 session 名、socket 路径、tmux 会话）。

### 父级退出时的清理

`session_shutdown` 事件触发。TUI 模式展示活跃会话确认对话框，headless 模式静默杀死。临时目录 `/tmp/pi-subagent-*` 一并清理。

## 开发约束

### 使用原生组件
所有 UI 渲染使用 pi 的原生组件（`Spacer`、`Box`、`Text` 等），不引入第三方 UI 库。

### 样式驱动排版
使用 pi 原生 `Text` 组件的 `paddingX` 参数控制缩进，需多行缩进时配合 `truncateToVisualLines`（内部创建 `Text` 组件）实现。避免手写 `" ".repeat()` 广告字符串拼接。

## 测试决策

只测协议，不测基础设施编排。核心 seam 是**长度前缀 socket 往返**：创建 server → 连接 client → 写入帧 → 验证 server 读取。边界：空消息、多字节 UTF-8、大消息、提前断开、Abort 信号。

pi mono 仓库不为其扩展提供测试，本仓库遵循相同约定。

## 不在此范围

- **Agent 定义文件**：不定义预设 agent 人格。Agent 由调用者参数完全定义。
- **并发限制**：`Promise.all` 不加限制，后续可按需添加。
- **Windows 支持**：Unix socket + tmux 仅限 Linux/macOS。
- **结构化输出**：子 agent 返回原始助手文本，不做 schema 强制。
- **持久化会话**：会话临时，父级退出即清理，不序列化。
- **守护进程**：子 agent 始终在 pi 进程中运行。

## 其它说明

- 扩展必须支持子模式自动加载（`~/.pi/agent/extensions/` 或 `pi install`），子 pi 实例启动时自动激活子模式行为。
