# pi-extensions monorepo

所有 pi 扩展的 pnpm workspace。设计意图与原则见根 [`SPEC.md`](SPEC.md)（新建包前先读）。

- `packages/pi-subagent` — 极简子代理，具体设计见其 [`SPEC.md`](packages/pi-subagent/SPEC.md)
- 新扩展在此新增一个 package

## 原则

- **TUI 即时反馈**：TUI 应该在执行的关键节点即时反馈有意义的信息给用户——通道/通道切换、活动流、进度、完成/失败都要在发生时就可见，而不是等最终结果一起出现。长时间静默（无 spinner、无状态词、无数据变化）是缺陷。preview 必须 1:1 反应真实行为。

## 约定

- 工具链只在根（biome / tsconfig / husky / lint-staged），各包不复制
- pi 依赖版本在 `pnpm-workspace.yaml` 的 `catalog:` 单一来源，包内 `peerDependencies` 用 `catalog:`
- `.github/workflows/` 由根管理：CI 全 workspace，release 在包目录逐个触发