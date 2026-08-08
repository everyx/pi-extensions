# pi-extensions

A pnpm workspace monorepo of [pi](https://github.com/earendil-works/pi) extensions. Each package is a plain, independently publishable pi extension.

| Package | What it is | npm |
|---|---|---|
| [`packages/pi-subagent`](./packages/pi-subagent/README.md) | Minimal sub‑agents for your Pi — two primitives, no noise, no limits. | `@everyx/pi-subagent` |

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

## Releasing

Each package releases independently with semantic-release. Tags are namespaced per package (`pi-subagent-v1.2.0`). Trigger the [Release workflow](.github/workflows/release.yml) manually (default is a `--dry-run` preview); it runs one job per package.