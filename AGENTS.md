# pi-extensions monorepo

所有 pi 扩展的 pnpm workspace。设计意图与原则见根 [`SPEC.md`](SPEC.md)（新建包前先读）。

- 6 个包全在 `packages/*`：清单与一行简介见根 README 表格，各包设计见各自 `SPEC.md`（pi-read-doc 无 SPEC，见 README）
- 新扩展在此新增一个 package

## 约定

- 工具链只在根（biome / tsconfig / husky / lint-staged），各包不复制
- pi 依赖版本在 `pnpm-workspace.yaml` 的 `catalog:` 单一来源，包内 `peerDependencies` 用 `catalog:`
- `.github/workflows/` 由根管理：CI 全 workspace；release 走 release-please manifest（版本 PR 统一 bump，合并后 `pnpm publish -r --provenance`）

## LLM 文案（工具描述 / 参数描述 / promptGuidelines）

写每行文案前问一句：**没有它，LLM 会错吗？** 不会就不写。

- **自省的不写**：参数名与枚举自述、结果形状（返回内容首次调用即自证）、换词重查等通用 agent 技能（训练先验已有）——描述它们的文案是纯 token 税，每次请求永久摊派。
- **单源**：同一契约只在一处出现。行为级契约（如“query 语言 = 结果语言”）进 promptGuidelines；字段级契约（格式约定、语义、省略行为）进参数描述——互相引用，不复写。
- **实现不可见**：路由、通道、failover、fallback 架构不进 LLM 文案——LLM 无法据此行动，它只见结果或终错。
- **错误分层**：LLM 可见文本是简洁错误，配置指引（装什么 key、怎么配）走 `details`（UI 可见），不进 LLM 上下文。
- **LLM API 无 breaking change**：schema 是给模型的，不是给代码的——行为变化用 `feat:`/`fix:`，不用 `!`。
