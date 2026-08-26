# pi-extensions monorepo

所有 pi 扩展的 pnpm workspace。设计意图与原则见根 [`SPEC.md`](SPEC.md)（新建包前先读）。

- `packages/pi-subagent` — 极简子代理，具体设计见其 [`SPEC.md`](packages/pi-subagent/SPEC.md)
- `packages/pi-sleep-guard` — 运行期阻断系统休眠，具体设计见其 [`SPEC.md`](packages/pi-sleep-guard/SPEC.md)
- 新扩展在此新增一个 package

## 约定

- 工具链只在根（biome / tsconfig / husky / lint-staged），各包不复制
- pi 依赖版本在 `pnpm-workspace.yaml` 的 `catalog:` 单一来源，包内 `peerDependencies` 用 `catalog:`
- `.github/workflows/` 由根管理：CI 全 workspace，release 在包目录逐个触发