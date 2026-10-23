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

- **`agent_spawn`** — 创建隔离的子 agent（一律立即返回 agent id，结果以通知送达；可选 `persistent` 常驻）。
- **`agent_stop`** — 销毁运行中的子 agent（常驻与否都适用）。
- **`agent_send`** — 实体间点对点消息投递（直接子 / `@parent`；路由由 LLM 自行完成）。

每个子 agent 是一个常驻 `pi --mode rpc` 子进程，拥有独立上下文与持久化会话。

## 用户故事

1. 委托子 agent 研究问题，不污染主会话上下文窗口，输出纯文本直接可用。
2. 并行探索多个独立问题——多个子 agent 同时运行，widget 显示状态，完成通知逐个到达。
3. agent 跑偏时发消息重定向，或直接 agent_stop 终止。
4. 为每个子 agent 独立覆盖模型和工具白名单（如廉价模型做侦察，强模型做实现）。
5. 子 agent 完成后从主会话（工具卡/通知卡）找到 session 路径，`pi --session <path>` 复盘完整过程。
6. 嵌套：子 agent 是完整 pi 实例，天然可再 spawn 孙 agent，无深度控制。
7. 父级退出时子进程经 stdin EOF 自动优雅退出（无孤儿进程）；显示行由显示面按 parent 链级联摘除（无孤儿行）——会话文件永不删除。
8. 协作：子 agent 中途遇到阻塞（缺信息/需决策），发消息给父会话请求帮助；父回复后子 agent 继续，上下文不丢。
9. 常驻：`persistent` 子 agent 完成后进程驻留 idle（零 token），之后随时被 `agent_send` 唤醒继续追问，无需重新 spawn。

## UI 设计

### agent_spawn 工具卡片

```
✓ agent_spawn "检查 CI 配置" (sonnet · high · Took 27.5s · done 2/3 · 1 running)
⠙ agent_spawn "检查 CI 配置" (claude-sonnet · high · Elapsed 12.3s)
Thinking...
bash: pnpm check
<空行>
... (12 earlier lines, ctrl+o to expand)
<子 agent 输出尾部 5 行>
<空行>
session: /path/...jsonl
```

- header：`⠋/✓/✗` + `agent_spawn` + `"label"` + muted meta——时间从 state 共享；卡片只表达「spawn 是否建成」，agent 的运行状态由 widget 行承担
- body：混合活动流——prompt 在流头，随后按事件顺序渲染子 agent 会话（Thinking... / 工具调用 / 流式文本）；随输出增长 prompt 与早期活动滚出折叠区
- footer：仅 `session: <path>`
- 推理强度：`thinking` 参数（"off"…"max"），省略时继承主会话当前值

**spawn 结果卡**（原地切换）：

```
⠋ agent_spawn "检查 CI 配置" starting…
✓ agent_spawn "检查 CI 配置" started
✗ agent_spawn "检查 CI 配置" start failed
  Model not found
```

- 状态一眼可辨（icon 前置）；失败原因按统一折叠规则处理（默认尾部预览 + 展开全显，对齐 bash 工具卡）
- agent id 只进 LLM 的 tool content，卡片上不出现

### agent_stop / agent_send 结果卡

```
✓ agent_stop "@zoe — research db schema" stopped

✓ agent_send "@zoe — research db schema" delivered
  重点看 orders 表的索引和慢查询

✓ agent_send "@parent" delivered
  我已经检查完，需要你确认部署窗口

✗ agent_stop "@max" stop failed
  agent not found
```

- agent_send 的 `to` = 子 agent 的短人名 id（spawn/通知给到的）或 `@parent`（父会话）
- 注入的消息以普通文本显示在卡片内，完整多行，超 10 行按 head 预览折叠（write 同款）
- 动画帧在同一行内切换，绝不追加新行
- 错误保持同一形态：状态行 error 色 + dim 原因行

### 完成通知卡片（persistent 时带 idle 标记）

```
✓ Agent "@max — 检查 CI 配置" completed (sonnet · high · Took 27.5s · 1,250 tokens · 3 tool uses · idle)
<空行>
... (3 earlier lines, ctrl+o to expand)
Found 5 files handling authentication: src/auth/*.ts …
<空行>
session: /path/...jsonl
```

- header：卡名是 `Agent`，不是工具名 `agent_spawn`——这张卡是「该 agent 完事了」的消息，写成工具名会与真实 spawn 卡逐字同形（#31）；状态由 icon（✓/✗/■）＋状态词（`completed` muted / `failed` error / `stopped` warning）承担，persistent 完成另在 meta 追加 `idle`
- 底色 `customMessageBg`（pi 给 injected message 的专用色）——工具底色留给真正的工具卡；注册了自定义渲染器 pi 就不再替你套这层（custom-message.js：渲染器 "handles its own styling"），得自己选
- 渲染数据在 `details`，不进 LLM 上下文

### 待送达报告行（aboveEditor，卡片落地即消失）

```
 Agent @abe — counter (queued): bg done
 Agent @zoe — index (failed · queued): <错误首行>
```

- 通知是 pi 的 steer：pi 在**父进程下一个循环边界**（当前这一步工具调用跑完）才把它交给模型，不是子代理结束的那一刻。中间这段时间报告已存在（widget 行随 agent 结束已经移除）但谁都没读到——UI 必须说出来，否则「行消失」与「卡片出现」看起来像同一件事发生了两次
- 形态取 pi 自己的排队消息块（`Steering:` / `Follow-up:`：aboveEditor、dim、单行截断）：一个未送达报告一行，按完成顺序堆叠。**不带** pi 那行 `↳ … to edit all queued messages`——那行暗示可以捞回编辑器改，而子代理报告不可编辑
- `(queued)` 是这份报告的状态，冒号后是它的头一行（多行只取首行非空行）；异常结局带上结局词，与卡片尾部同一套词汇，`queued` 取 pi 的队列词汇
- 生命周期：交给 pi 的那一刻出现，**卡片真正落进转录的那一刻消失**（pi 的 `message_end` 事件就是卡片出现）；会话被中途杀掉不专门兜底——widget 随会话一起走
- 独立 widget key（`pi-subagent-pending`），不参与 Agents 的 `done n/total` 计数：同一件事不报两遍

### Agents 状态 widget（aboveEditor）

```
  ● Agents (done 1/3 · 2 running · 1 idle)
  ⠋ @max — 检查 CI 配置 (42.0s)
  ‖ @zoe — 驻留探索代理
```

- 跟踪所有 spawn 的 agent；完成后非 persistent 移除、persistent 转 idle 驻留保持可寻址
- 非 persistent 完成/停止立即移除——完成结果由通知卡承担；**persistent 完成后保留 idle 行**（可寻址性可见，‖ 标记，不参与进度计数，可被 agent_stop 移除）
- 嵌套行（tree telemetry）用 **upsert** 而非 add：同一个 persistent 后代会上报两次（spawn 落定 = running，驻留 = idle），第二次是状态变更不是重复——`add` 对已知 id 是 no-op，用它会让该行永远转圈
- 标题行 meta（外层括号 + `·` 分隔，对齐 card header）：`done n/total` 进度 + 实时分段（`n running` / `n idle`）+ 异常计数（`n failed` error 色 / `n stopped`）——行空 widget 消失，计数随下次任务批重置
- **蜂群降级**：行数超出预算时自动切换——running（活跃）与 failed（异常）行优先，其余折叠为计数行（对齐 Kimi swarm 两档思路）
- 每行下方追加最新活动摘录（与标题文本起点对齐，实时更新）：工具调用、Thinking...、或最新正文尾部；截断宽度感知终端宽（render 传入），尾部截断

## 实现决策

### 架构

```
index.ts           — 工具注册（agent_spawn / agent_stop / agent_send）+ 路由粘合
protocol.ts        — 纯函数 JSONL 协议层
rpc-client.ts      — 状态化薄 JSONL 客户端（spawn + 事件流 + 退出）
event-interpret.ts — 原始 RpcEvent → AgentEvent 适配层（纯函数）
agent-process.ts   — AgentProcess：一个常驻 rpc 子进程的语义封装
notification.ts    — 完成通知 payload 构造（LLM JSON 截断/stash + details 卡形状单点）
pending.ts         — 待送达报告行：通知尚未落进转录时的排队显示
tree-display.ts    — 子树显示面（显示面统一规则锚点：fold/forward/widget 决策 + 计数）
registry.ts        — AgentRegistry：运行中 Agent 生命周期 + 点对点投递 + 完成策略
model.ts           — model spec → resolved model（纯函数）
types.ts           — 共享协议类型（RenderEvent / SubagentDetails / NotificationDetails）
render.ts          — 通知卡渲染器（消息面）；格式化直接取自 pi-ui（spinner.js/width.js 正典出口）
widget.ts          — Agents 状态 widget
name-gen.ts        — 短人名代理 id（测试）
spawn-session.ts   — spawn 生命周期（单一非阻塞路径）+ 子树 drain 规则（表测试）
nested-fold.ts     — 前景卡子树 telemetry 计数
views.ts           — 三张工具卡 view（单一来源）
card.ts            — 通知卡包装（通过 pi-ui）
preview.ts         — dev-only storybook（随包发布但无运行时影响）
```

### RPC 协议

- 线格式：JSONL（LF 分隔，与 pi 的 jsonl.js 一致），命令带 id 关联
- 子进程 detached（独立进程组）：stop 的 SIGTERM 级联到整棵进程树，不遗留孤儿孙进程
- **Windows 启动方式**（`spawnTarget`，纯函数、带测试）：`pi` 是 npm bin shim，原生 Windows 上 Node 既执行不了 PATH 里那个无扩展名的 sh 脚本（ENOENT，该平台的 ENOENT 也覆盖「存在但不是可执行类型」），也直接 spawn 不了 `pi.cmd`（EINVAL，需 cmd.exe 包装）。因此 Windows 下用**拉起自己的那个 node** + 自己启动时用的 CLI 脚本（`process.argv[1]`，绝对化后使用——子进程 cwd 是 agent 的，不是我们的）跑子进程——就是 shim 自己干的事，既绕开 PATHEXT 解析，也不把参数交给 cmd.exe 二次解析（`shell: true` 会，且路径含空格/`&` 时危险）。非脚本启动器（打包二进制）退回 `pi`，由 libuv 自行匹配 `.exe`
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
- **persistent**：显式开启（`agent_spawn(persistent: true)`），默认不常驻（行为不变）——"不设隐藏限制，限制由调用者显式要求"；全场景可用（驻留范围 = 宿主会话生命周期）
- **idle 语义**：进程驻留、零 token（rpc 模式命令驱动，无 turn 不调模型）；完成通知带 `idle` 标记；widget 保留 idle 行（可寻址性可见）；可被 agent_stop 杀掉
- **stop**：stdin EOF 优雅退出，`stoppedByControl` 抑制通知
- **失败与超限都返回 isError 工具结果**，与 bash 的 `exit N` / `(cancelled)` 对齐
- **扩展 reload 不留孤儿**：reload 时 pi 在旧扩展 runner 上派发 `session_shutdown(reason="reload")`（旧 handler 仍在活跃状态），扩展统一调 `registry.shutdown()` 优雅停掉本实例的子代理（stdin EOF）；宿主崩溃时子代理经 stdin EOF 自动退出。所有清理都绑定在**各自进程**的事件上，无跨进程共享状态，多 pi 实例互不干扰

### 消息模型（点对点投递，路由归 LLM）

- **id**：短人名（`max` / `zoe` / `kai`…，随机池 + 进程内查重）——**无树结构**——对 LLM 只是"系统给的引用"（信息披露是唯一限制：父持有 spawn 的子 id、子知道 `@parent`）
- **@ 引用语法**：受控文本（卡 title、widget 行、LLM content、通知 JSON）统一 `@max`——用户匹配对话里的 `@max`；参数 `to` 接受前导 `@`（机制剥除，引导的配套承诺）；`[from max]` 结构化标注保持裸名
- **机制 = 纯投递器**：`agent_send(to)` 只投"直接子精确 id"或 `@parent`——**不认识的目标显式报错**——无自动转发、无机制层寻路
- **路由 = LLM**：跨层/兄弟协调由每层 LLM 逐跳发起（它只寻址自己知道的 id；孙→祖 = 每跳 `@parent` 转发）——机制不做任何中间决策
- **发现机制很薄**：子知道谁 = 父 spawn prompt 告知 + 消息 from 字段（文本 `[from max]` 前缀，rpc 投递只传字符串，文本级标注最省）

### 通道（零新端点，全复用现有基础设施）

```
父→子：现有 rpc（prompt / steer，见 RPC 协议投递策略）
子→父：extension_ui_request（rpc 模式 setStatus 携带 JSON，专属 key "pi-subagent-msg"；
        fire-and-forget 尽力投递，无确认——本地 rpc 通行可靠）
注入/唤醒：pi.sendMessage（deliverAs: "steer" + triggerTurn: true）
```

- **零 socket、零文件写入、零轮询**——纯内存事件流
- 注入语义（已实证）：父 streaming（工具 execute 挂起/LLM 跑）→ 消息排队不抢占；父空闲 → 立即起新 turn 唤醒
- 事件天然带身份：每个 AgentProcess 持有自己的 RpcClient 连自己的子进程——收到 extension_ui_request 的 client 即消息来源，无需 id 字段
- 身份注入：spawn 时环境变量 `PI_SUBAGENT_AGENT_ID`（本 agent 人名 id，子进程据此自认是子）；agent_send 全实例注册，仅上行 UI 上报限子进程（hasParent）

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

- `pi.sendMessage` → `deliverAs: "steer"` + `triggerTurn: true`
- **必须是 steer，不是 followUp**（2026-10-20）：followUp 只在模型不再调用工具时排空（`agent-loop.js:192`），而等结果的模型恰恰一直在调工具（sleep 轮询）——永远排不空 = 死锁。steer 在每个工具边界排空（`agent-loop.js:180`），等待方式怎么变都不会卡住。三处投递（完成通知、`@parent` 插话、父→子 `agent_send`）现在同一模式
- content：`{status, agent_id, result, session_path}`（LLM 可见）；persistent 时追加 `idle: true`
- details：渲染数据，不进 LLM 上下文；persistent 通知卡追加 idle 状态词
- spawn 失败不投递通知：isError 工具结果已经同时告知 LLM 和用户，重复的通知只会说两遍
- **唤醒轮次同样投递**（2026-08-22）：persistent 代理被 agent_send 唤醒并成功完成后，输出经 onIdle → notifyCompletion 回到派发者上下文——与首轮对称（否则 `agent_send` 只回 "delivered"，答案落在父看不见的地方）。主动 stop（stoppedByControl）保持静默；失败唤醒照旧报 failed
- **投递延迟是 pi 的语义，不是 bug**（2026-10-12 实测）：子代理完成 → widget 行当刻消失，通知卡要到父进程下一个循环边界才出现（实测父进程 `sleep 30` 在跑时差 18.2s；父进程空闲时两者同刻）。pi 0.85.1（1.0 前）行为一致，非版本回归。这段等待由「待送达报告行」显式承担

### Graceful turn limits

- **默认不限**——对齐 Codex/CC 的克制姿态。唯一限制是可选 `timeoutMs`（毫秒），未传 = 无限制
- token 无任何限制；`get_session_stats` 仅用于通知卡统计
- **非自然结束必须说明原因**（issue #51）：`completed` 自带答案，其余结束都是子进程被从外面切断了——它自己什么都没说。所以 `endingNote()` 给 stopped（到点）和 failed（报错/非零退出）追加一段：说清是什么让它结束，并指明 `resume` 可续；`withEnding()` 把它接在子代理已产出的部分后面（只追加，不替换）。没有这句，父代理只能猜（现场原话「被中断了」），然后从头重跑——实测重烧 30 分钟，而能续的 session 就在手边

### 会话存储

- 目录在 pi 标准会话树之外——`pi -r` 保持干净；永不删除
- `--name` 始终传递：label（80 字截断）——label 是纯 UI 标签，不影响子代理行为
- attach：`pi --session <path>`

### 嵌套

子实例是完整 pi（加载全局扩展），天然可再 spawn；不注入 depth、不设 max_depth。子进程扩展经 `PI_SUBAGENT_AGENT_ID` 获得自身身份——孙 agent 由子进程自身 registry 分配人名 id。

### 显示面统一规则（2026-10-19 重写：单一非阻塞 spawn）

**一条路径**：`agent_spawn` 永远立即返回 agent id，结果以 Completion 通知送达。没有前台/后台之分，所以也没有「卡片在开着时折叠子树」这回事——卡只表达「spawn 是否建成」，agent 的运行状态全部由 widget 行承担。

- **root**：把收到的树事件应用为 widget 行（自身一行，后代按 depth 缩进）
- **非 root**：逐跳 verbatim 转发（depth + 1），最终由 root 落到 widget

机制：所有节点对**所有** spawn 上报树事件，`parent`（直系父 id）逐跳原样保留、只有 depth 增长。`resolveTreeAnchor` 因此只剩两个分支（forward / widget）——fold 分支随前台 spawn 一起删除。

**父行消失即子树消失**：节点被停/完成时，它自己就是「报告子孙行 remove」的那个进程——进程一死，遥测随之中断（stdin EOF 会级联杀死后代进程，但不产生任何事件）。所以 `AgentWidget.remove` 递归摘掉该行整棵子树，结果一律记 `stopped`——按构造，此时仍在世的后代都是被祖先的退出带走的。

**子树未清空则不 teardown（drain 规则）**：一个 agent 自己的回合结束，不代表它的活干完了——它 spawn 的后代还活着，而后代会随它一起死（stdin 管道关闭）。所以结算前要问 `hasLiveDescendants`：为空则正常上报 + 结束；不为空则把它标 idle（零 token，widget 显示 ‖）并等 `whenDrained`，清空后才上报。规则本身在 `spawn-session.ts:holdUntilDrained`。

**生命周期不依赖显示面**（2026-10-19 review 抓到的 blocker）：谁是活的、谁挂在谁下面，唯一权威是 `live-tree.ts`。widget 只是它的一个视图，**不能**用「行在不在」判断「进程活不活」——每个子 agent 都以 `pi --mode rpc` 运行，那里根本没有 widget（`ensureWidget` 在非 tui 模式返回 null）。早先把 drain 判断写成 `if (widget) holdUntilDrained(...)`，等于在子 agent 进程里整条规则空转：深度 2 时靠 root 的 hold 侥幸存活，深度 ≥3 时中间层的子 agent 回合一结束就把自己的子进程连带杀掉。实测对照：同一脚本下旧写法在 T+31s 就让 L1 上报 completed（L3 尚需 40s），新写法等到 T+61s 才上报。

注册表的 `widgetSurface()` 因此**永远返回**（不再在非 TUI 下返回 null）：`add`/`remove` 负责更新 `liveTree`，只有绘制部分才看 widget 是否存在。

**词汇单源**：计数词汇 `done n/total · …` = pi-ui `counterParts`；`@id — label` 标题 = views.ts `agentTitle`（widget 行与通知卡共用）；状态图标 = pi-ui card.ts。

### 恢复既有会话（2026-10-19）

`agent_spawn(resume: "<session path>", prompt, label)`：子进程用 `--session <path>` 启动（不再是 `--session-dir`），pi 加载那段历史，本次 prompt 在其上继续。恢复后是**新 id**——旧 id 已随进程消失，复用会让「id ↔ 进程」的对应关系带条件。

路径来源：完成通知的 LLM 可见 JSON 里有 `session_path`，卡片 footer 里也给人看。

边界校验只做三件 pi 做得不好或会静默出错的事（实测：目录 → 裸 `EISDIR`，不说是哪个参数；**空文件 → 不报错，直接当新会话跑**，调用方以为恢复了、实际上下文是空的）：

- 路径不存在 → `session not found: <path>`
- 不是普通文件 → `not a session file: <path>`
- 空文件 → `session file is empty (nothing to resume): <path>`

会话格式本身交给 pi：损坏文件它会明确回 `Session file is not a valid pi session`，权限错误也只有拥有者进程能判断——在扩展里重写解析器只会多一份真相。

`--session` 与 `--session-dir` 互斥地表达同一件事（会话落在哪里），所以恢复时不传后者。

### 会话结束时的事实（2026-10-19）

pi 退出会带走所有子 agent（stdin EOF 级联），但模型不知道：它的上下文还写着这些 agent 在跑。所以在 `session_shutdown` 里把「哪些 agent 随会话结束而终止」写成一条 `custom_message`（`customType: "subagent-session-end"`、`display: false`）：

- 机制与 pi 自己的 compaction 摘要完全一致：**写一次会话条目，恢复时由 `sessionEntryToContextMessages` 自然投影进上下文**，不做「恢复时主动注入」，也就不需要判断是不是恢复、不会重复注入
- `display: false` 让用户看不到它，但它仍然进模型上下文（`convertToLlm` 把 custom 消息转成 user 消息，不看 display）
- 成本：一条约 20 token，且只在真有存活 agent 时才写
- 配套的错误文案（`routeMessage` / `agent_stop`）改成 `X is not running any more — spawn a new agent instead.`——只给出下一步动作，不重复会话事实（单源）

### spawn 不再阻塞（2026-10-19 取代「子代理禁止后台 spawn」）

原规则的理由是：子代理的生命周期被父的同步等待封顶，它起的后台子要么活不过父的返回，要么逼出收条 turn。**根因是「阻塞」本身**，不是子代理 —— 所以直接删掉阻塞：`run_in_background` 参数消失，所有 spawn 立即返回 agent id，结果以通知送达，任何层级都一样。

由此产生的两个必须配套的规则：

- **drain 规则**（见「显示面统一规则」）：子 agent 回合结束但子孙未清空时保持 idle 存活，等子树清空才上报 + 结束。这一条取代了原先「子代理不能起后台子」的禁令。
- **答案完整性**：非阻塞意味着子 agent 可能在子孙结果回来前就产出答案。机制保证「结果一定能回来（会唤醒它）」，但「要不要等」是 LLM 的判断，由 promptGuidelines 明说：「如果你的回答依赖它的结果，等完成通知再作答」。

**persistent** 语义不变：完成后不退场、可继续对话，活到宿主会话结束。

### 本地 E2E：子进程也必须加载工作树（2026-10-19 踩过）

`RpcClient` 起子进程时只传 `--mode rpc`（不加 `-e`），所以**子 agent 加载的是用户已安装的 npm 包，不是工作树代码**。只跑 `pi -ne -e <local index.ts>` 只能验证 root 这一层：嵌套路径（子代理自己 spawn）跑的仍是已发布的旧逻辑。

后果很隐蔽——不是报错，是**测试通过但测的不是新代码**：本轮验证「非阻塞 spawn」时，外层 agent 的会话记录里 `agent_spawn` 的 tool result 直接就是子代理答案（旧版阻塞行为），而当时工作树早就不返回答案了。查了会话 JSONL 才发现。

做法：E2E 期间临时给子进程 argv 加 `-ne -e <abs path to index.ts>`，跑完立刻还原（这是测试脚手架，不是产品行为）。判据：如果外层的 `agent_spawn` tool result 里出现子代理的最终答案，说明它跑的是旧包。

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
