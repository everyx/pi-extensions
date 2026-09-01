# pi-extensions

[English](README.md) | [中文](README.zh.md)

我的私人 [pi](https://github.com/earendil-works/pi) 扩展集——五个可独立发布的扩展 + 它们共用的 UI 库 pi-ui。

| 包 | 是什么 |
|---|---|
| [`@everyx/pi-subagent`](./packages/pi-subagent/README.zh.md) | Pi 的协作式子代理——三原语、有名有姓、互通消息，调度权在你。 |
| [`@everyx/pi-web-tools`](./packages/pi-web-tools/README.zh.md) | Web 原语——搜索 + URL 抓取（URL → Markdown），通道路由 + 限流。 |
| [`@everyx/pi-sleep-guard`](./packages/pi-sleep-guard/README.zh.md) | 运行时阻断休眠——任意 pi 进程运行时 `caffeinate`/`systemd-inhibit` 持锁。 |
| [`@everyx/pi-status-line`](./packages/pi-status-line/README.zh.md) | Pi 原生状态栏——`↓` 后同行 `TPS/TTFT`（`T/s`）。 |
| [`@everyx/pi-read-doc`](./packages/pi-read-doc/README.zh.md) | 增强 read——Office 文档（Word/Excel/PowerPoint/PDF）经 anydoc 转 Markdown，hosted→rapid 回退。 |

## 布局

- `packages/*` — 一个目录一个包；五个 pi 扩展各带 `pi.extensions` 入口（pi-ui 是库，非扩展）。各自的 README 随 npm 包发布。
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