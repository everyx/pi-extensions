# pi-web-tools

[English](README.md) | [中文](README.zh.md)

Web primitives for Pi — `web_search` + `web_fetch`.

- **`web_search`** — search the web. Requests route across HTTP search providers in fuse order — TinyFish (free, unlimited) → Exa → Tavily → Firecrawl (Google-backed; keyless first, key only as escalation) — with automatic failover; a real-browser engine (Google, Baidu for Chinese via BrowserSkill) is the last-resort no-key fuse. Five params: `query`, `recency?`, `allowed_domains?`, `blocked_domains?`, `locale?`. Results follow the query's language; `locale` is the explicit market/language boost. No engine param — routing is invisible to the LLM.
- **`web_fetch`** — fetch a URL: HTML pages convert to Markdown by default (LLM / token friendly), pass `raw: true` to get the source HTML as-is. Non-HTML (SVG/JSON/text — anything textual) is always returned as-is; oversized non-web content is stashed to /tmp with a pointer instead of an inline preview (the LLM pages through it via `read`). Images (`image/*`, except SVG) are returned as multimodal image blocks — rendered inline in the TUI and consumed by the model directly. The response Content-Type travels in the result metadata. Fetches use a pinned modern Chrome User-Agent with markdown content negotiation; anti-bot / JS-rendered pages advance to the fuse (tinyfish fetch → real browser) automatically.

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

| Variable | Meaning |
|---|---|
| `TINYFISH_API_KEY` | Enable the TinyFish channel (free, unlimited volume, 30 req/min) — the primary channel. |
| `EXA_API_KEY` | Exa keyed mode (full params). Without it Exa still runs keyless via MCP (bare queries, 3 qps / 150 calls per day). |
| `TAVILY_API_KEY` | Enable the Tavily channel (1,000 credits/month free). |
| `FIRECRAWL_API_KEY` | Firecrawl keyed escalation. Without it the channel runs keyless (free, per-IP daily caps). Never touched while keyless quota lasts — the pool is shared with pi-read-doc's OCR. |

Zero keys still works: keyless Exa + keyless Firecrawl, with the real-browser fuse behind them. The real-browser channel uses [BrowserSkill](https://github.com/Tencent/BrowserSkill) (`bsk` CLI); install it separately.

## Notes

- **Not compatible with pi-web-access**: both register a `web_search` tool. Uninstall one of them.
- Design intent and requirements: [`SPEC.md`](SPEC.md).
