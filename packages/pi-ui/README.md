# pi-ui

Shared TUI primitives for the `@everyx` pi packages — a published **library**, not an extension (no `pi.extensions` entry, no `index.ts` barrel).

Packages import per-module deep paths: `@everyx/pi-ui/card.js` (note: published as raw `.ts`, so `.js` resolves to the module by name). Only the imports other packages actually use are public API.

| module | content |
|---|---|
| `card.js` | card header / body / fold rendering, status icons, `cardShell`, `renderCard` |
| `view.js` | `createToolView` — tool-result card template |
| `widget.js` | `StatusWidget` — live status rows (agents widget) |
| `spinner.js` | `Spinner`, `durationMeta` / `formatDuration`; re-exports `clipTail` / `safeTitle` |
| `ticker.js` | `ticker` — periodic timer helper |
| `width.js` | width safety — `safeTitle`, `clipTail`, `capPlain`, `structRow` |
| `context.js` | context-stash helpers (stash large payloads out of LLM context) |
| `preview-runtime.js` | dev-only preview runtime (storybook) |

Design intent and requirements: [`SPEC.md`](SPEC.md).