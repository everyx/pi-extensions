# pi-extensions

[pi](https://github.com/earendil-works/pi) 扩展的 pnpm workspace monorepo。每个包都是一个可独立发布的 pi 扩展。

| 包 | 是什么 | npm |
|---|---|---|
| [`packages/pi-subagent`](./packages/pi-subagent/README.zh.md) | Pi 的极简子代理——双原语、无噪音、无限制。 | `@everyx/pi-subagent` |

## 布局

- `packages/*` — 一个目录一个扩展，各自的 README（随 npm 包发布）与 `package.json`（`pi.extensions` 入口）。
- 工具链只在根级一份——biome、TypeScript（单一根 `tsconfig.json` 检查 `packages/**`）、husky、lint-staged。各包不复制开发工具。
- pi 依赖版本在 `pnpm-workspace.yaml` 的 `catalog:` 中单一来源声明；各包 `peerDependencies` 用 `catalog:` 引用。

## 开发

```bash
pnpm install      # 安装整个 workspace
pnpm check        # biome 检查 + 格式化
pnpm typecheck    # tsc --noEmit 覆盖所有包
pnpm test         # 跑每个包的测试
```

跑单个包的脚本：`pnpm --filter <pkg> <script>`（如 `pnpm --filter pi-subagent preview`）。

### 本地挂载某扩展

在 `~/.pi/agent/extensions/` 里链接包目录，然后重启 pi：

```bash
ln -s $PWD/packages/pi-subagent ~/.pi/agent/extensions/subagent
```

## 发布

每个包经 semantic-release 独立发布，tag 按包命名空间隔离（如 `pi-subagent-v1.2.0`）。手动触发 [Release workflow](.github/workflows/release.yml)（默认 `--dry-run` 预览），每个包一个 job。