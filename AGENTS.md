# pi-extensions monorepo

所有 pi 扩展的 pnpm workspace。设计意图与原则见根 [`SPEC.md`](SPEC.md)（新建包前先读）。

- 6 个包全在 `packages/*`：清单与一行简介见根 README 表格，各包设计见各自 `SPEC.md`
- 新扩展在此新增一个 package

## 约定

- 工具链只在根（biome / tsconfig / husky / lint-staged），各包不复制
- pi 依赖版本在 `pnpm-workspace.yaml` 的 `catalog:` 单一来源，包内 `peerDependencies` 用 `catalog:`
- `.github/workflows/` 由根管理：CI 全 workspace；release 走 release-please manifest（版本 PR 统一 bump，合并后 `pnpm publish -r --provenance`）
- **跨包版本耦合**：给库包（如 pi-ui）新增导出 = 该包必须用 `feat:`/`fix:` 提交——release-please **不 bump `refactor:`**，而消费者包（如 pi-web-tools）发版会把它对库包的 `workspace:*` 解析到最新已发布版；库包没发 = 消费者装即炸（曾发生）。merge release PR 前核对 PR 包清单是否含全部被依赖方。

## LLM 文案（工具描述 / 参数描述 / promptGuidelines）

写每行文案前问一句：**没有它，LLM 会错吗？** 不会就不写。

判据按字段分开问，否则"会不会错"没有抓手：

- **snippet**：不写，模型会在错误的时候选这个工具吗？
- **description**：不写，模型会不知道调用后发生什么吗？
- **参数描述**：不写，模型会填错值吗？
- **guideline**：读过 snippet、description 和一次真实结果之后，模型还会做错吗？

### 分层：一条信息放哪，由"第一次被需要的那一刻"决定（2026-10）

| 层 | 内容 | 载体 | 预算 |
|---|---|---|---|
| L0 选择 | 什么时候该用它 | `promptSnippet` | ≤10 词 |
| L1 契约 | 调用后发生什么 + 参数怎么填 | `description` + 参数 schema | 1–2 句 |
| L2 行为 | 读过 L0/L1 和一次真实结果后还会错的事 | `promptGuidelines` | 每条都要能证明"不写会错" |
| L3 事实 | 刚刚发生了什么 | 工具结果 / 通知 content | — |
| L4 细节 | 全文、用量、会话路径 | `details` / 文件 | 永不进上下文 |

**批量三规则**（省 token 的主力是第 2 条）：

1. 一条事实只在它的层出现一次（重复必然漂移）。
2. 上层不复述下层：snippet 不说机制，description 不说用法，guidelines 不说接口。
3. 共享同一触发时机的条目合并成一条。

**snippet 是必填的**：pi 的工具列表按 snippet 存在与否过滤（`visibleTools = declaredTools.filter(name => !!toolSnippets[name])`）——没有 snippet 的工具在 system prompt 里根本不出现，这是正确性问题，不只是省 token。

### 机器闸门（样板：`packages/pi-subagent/test/llm-copy.test.ts`）

判断"这条该不该写"是语义活，测试做不了；但**总量增长是可测的，而增长正是膨胀的第一信号**。所以文案集中的包应有一条 ratchet 测试：文案集中在 `copy.ts` 一类的单文件里，断言总字符数、guideline 条数、跨工具不重复。要加文案就得在同一提交里显式改数字——**数字出现在 diff 里，就是 review 的钩子**。

门槛：**工具数 ≥3 或文案 >800 字符才值得上**。`pi-read-doc`（1 个工具 / 139 字符）和 `pi-web-tools`（2 个 / 691）刻意没有：为它们建 copy 文件 + 预算测试，维护成本高于收益。规则的意义是拦住增长，不是给每个包套一层壳。

### 其余约定

- **自省的不写**：参数名与枚举自述、结果形状（返回内容首次调用即自证）、换词重查等通用 agent 技能（训练先验已有）——描述它们的文案是纯 token 税，每次请求永久摊派。
- **单源**：同一契约只在一处出现。行为级契约（如"query 语言 = 结果语言"）进 promptGuidelines；字段级契约（格式约定、语义、省略行为）进参数描述——互相引用，不复写。
- **实现不可见**：路由、通道、failover、fallback 架构不进 LLM 文案——LLM 无法据此行动，它只见结果或终错。
- **错误分层**：LLM 可见文本是简洁错误，配置指引（装什么 key、怎么配）走 `details`（UI 可见），不进 LLM 上下文。**且必须落在渲染器真会读的键上**——本仓卡片渲染的文字通道是 `details.error`（`pi-ui/view.ts` 只把 `details.data` + `details.error` 交给视图），写进没人读的字段等于写给空气。
- **LLM API 无 breaking change**：LLM 面向的接口（schema/描述/prompt）是模型侧的 UI——模型每次请求都读当前版本，不存在依赖旧版的下游，所以改动它（含改参数名、删字段）不算 breaking change：提交一律 `feat:`/`fix:`，不用 `!`。
