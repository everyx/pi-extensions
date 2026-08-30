# pi-extensions

[English](README.md) | [中文](README.zh.md)

My personal [pi](https://github.com/earendil-works/pi) extensions — each package a plain, independently publishable pi extension.

| Package | What it is |
|---|---|
| [`@everyx/pi-subagent`](./packages/pi-subagent/README.md) | Pi agents that work together — three primitives, a tree of named agents, no noise. |
| [`@everyx/pi-web-tools`](./packages/pi-web-tools/README.md) | Web primitives — `webSearch` + `fetch` (URL → Markdown), channel-routed + rate-limited. |
| [`@everyx/pi-sleep-guard`](./packages/pi-sleep-guard/README.md) | Block system sleep while any pi agent runs — per-process caffeinate/systemd-inhibit. |
| [`@everyx/pi-status-line`](./packages/pi-status-line/README.md) | Pi-native footer — TPS/TTFT inline after `↓` (`T/s`). |
| [`@everyx/pi-read-doc`](./packages/pi-read-doc/README.md) | Enhanced read — office docs (Word/Excel/PowerPoint/PDF) via anydoc → markdown, hosted→rapid fallback. |

## Layout

- `packages/*` — one pi extension per directory, each with its own `README` (ships with the npm package) and `package.json` (`pi.extensions` entry).
- Shared tooling lives at the root only — biome, TypeScript (one root `tsconfig.json` checking `packages/**`), husky, lint-staged. Packages never duplicate dev tooling.
- pi dependency versions are declared once in the `catalog:` section of `pnpm-workspace.yaml`; every package references them with `catalog:` in its `peerDependencies`.

## Development

```bash
pnpm install      # install the whole workspace
pnpm check        # biome lint + format
pnpm typecheck    # tsc --noEmit over all packages
pnpm test         # run every package's tests
```

To run a package's own scripts: `pnpm --filter <pkg> <script>` (e.g. `pnpm --filter pi-subagent preview`).

### Loading a package locally into pi

Link its directory from `~/.pi/agent/extensions/…`, then restart pi:

```bash
ln -sf $PWD/packages/pi-subagent ~/.pi/agent/extensions/subagent
```