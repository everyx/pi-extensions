# pi-extensions monorepo

所有 pi 扩展的 pnpm workspace。

- `packages/pi-subagent` — 极简子代理，设计意图见其 `SPEC.md`，规则见 `packages/pi-subagent/AGENTS.md`
- 新扩展在此新增一个 package

约定：
- 工具链只在根（biome / tsconfig / husky / lint-staged），各包不复制
- pi 依赖版本在 `pnpm-workspace.yaml` 的 `catalog:` 单一来源，包内 `peerDependencies` 用 `catalog:`
- 按包提交时遵守该包目录下的 AGENTS.md（若无则遵本文件）
- `.github/workflows/` 由根管理：CI 全 workspace，release 在包目录逐个触发