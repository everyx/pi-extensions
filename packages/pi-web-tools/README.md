# pi-web-tools

[English](README.md) | [中文](README.zh.md)

Web primitives for Pi — `web_search` + `web_fetch`.

- **`web_search`** — search the web. Requests route across HTTP search providers in fuse order — TinyFish (key required, 30 req/min) → Exa → Tavily → Firecrawl (Google-backed; keyless first, key only as escalation) — with automatic failover. Five params: `query`, `recency?`, `allowed_domains?`, `blocked_domains?`, `locale?`. Results follow the query's language; `locale` is the explicit market/language boost. No engine param — routing is invisible to the LLM.
- **`web_fetch`** — fetch a URL: HTML pages convert to Markdown by default (LLM / token friendly), pass `raw: true` to get the source HTML as-is. Non-HTML (SVG/JSON/text — anything textual) is always returned as-is; oversized non-web content is stashed to /tmp with a pointer instead of an inline preview (the LLM pages through it via `read`). Images (`image/*`, except SVG) are returned as multimodal image blocks — rendered inline in the TUI and consumed by the model directly. The response Content-Type travels in the result metadata. Direct fetches run in-process through Node's fetch (proxy-aware: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are honoured); anti-bot / JS-rendered pages advance to the rendering fuse — `firecrawl scrape` (no key needed today) then `tinyfish fetch` (keyed) — under one shared 45 s budget, and only when rendering could actually change the answer (not for 404/410, paywalls, quota or legal blocks).

Two primitives, nothing else — no content storage, no curator, no PDF/video extraction.

## Install

```bash
pi install npm:@everyx/pi-web-tools
```

## Usage

```
Search the web for the pi extension API docs
```

```
Fetch https://github.com/earendil-works/pi/blob/main/README.md and summarize it
```

## Configuration

### Where the keys come from

Two sources, first one wins:

1. **Environment** — `TINYFISH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`. Best for CI, scripts, and anything that already exports them.
2. **`<agent dir>/web-tools.json`** — a flat file for people who would rather not edit shell config (`~/.pi/agent/web-tools.json` by default):

```json
{ "tinyfish": "…", "exa": "…", "tavily": "…", "firecrawl": "…" }
```

A missing, unreadable, or malformed file contributes nothing — exactly like an unset variable. Nothing is ever written to it.

It holds plaintext keys, so keep it yours: `chmod 600 ~/.pi/agent/web-tools.json`. It belongs in your home directory, not in a shared or synced folder. Keys are per user, so there is no project-level variant (and no risk of committing one).

`pi` has no extension secret store of its own (`auth.json` belongs to LLM providers); this two-source arrangement is the convention the other pi web extensions converged on.

### Environment variables

| Variable | Meaning |
|---|---|
| `TINYFISH_API_KEY` | Enable the TinyFish channel (30 req/min). Since 2026-11 their API answers 401 without a key, for search and rendering alike. |
| `EXA_API_KEY` | Exa keyed mode (full params). Without it Exa still runs keyless via MCP (bare queries, 3 qps / 150 calls per day). |
| `TAVILY_API_KEY` | Enable the Tavily channel (1,000 credits/month free). |
| `FIRECRAWL_API_KEY` | Firecrawl keyed escalation. Without it the channel runs keyless (free, per-IP daily caps). Never touched while keyless quota lasts — the pool is shared with pi-read-doc's OCR. |

Zero keys still works: keyless Exa + keyless Firecrawl (both answer without a key today; neither vendor guarantees it — when one changes, the channel fails over and the card says so). No binary to install — every channel is an HTTP API. A real-browser channel (BrowserSkill/`bsk`) used to sit at the end of both chains; it is gone, because a fallback pinned to a third-party CLI's argument shape breaks whenever that CLI changes, and the tail of a fuse is the one place with nothing behind it.

**Privacy:** the direct path never proxies — your machine fetches the page. The rendering fuse does: when a page is behind an anti-bot wall or renders only in a browser, the **target URL is sent to Firecrawl** (or TinyFish, when keyed) to get the content back. That is the price of rendering a page plain HTTP cannot deliver, and it is on by default so that "install and it works" stays true. If you would rather not, restrict yourself to pages that answer plain HTTP.

## Notes

- **Not compatible with pi-web-access**: both register a `web_search` tool. Uninstall one of them.
- Design intent and requirements: [`SPEC.md`](SPEC.md).
