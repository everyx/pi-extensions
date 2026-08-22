# pi-web-tools

[English](README.md) | [中文](README.zh.md)

Web primitives for Pi — `web_search` + `web_fetch`.

- **`web_search`** — search the web. Free-tier search APIs first (Exa / Tavily / Parallel), then real-browser search (Google / Bing / Baidu / Yandex via BrowserSkill). Engine defaults follow the system language (e.g. a Chinese system adds Bing, served from cn.bing.com); pass `locale` explicitly for localized results; full search-operator syntax when you pick an engine explicitly.
- **`web_fetch`** — fetch a URL: HTML pages convert to Markdown by default (LLM / token friendly), pass `raw: true` to get the source HTML as-is. Non-HTML (SVG/JSON/text — anything textual) is always returned as-is; oversized non-web content is stashed to /tmp with a pointer instead of an inline preview (the LLM pages through it via `read`). Images (`image/*`, except SVG) are returned as multimodal image blocks — rendered inline in the TUI and consumed by the model directly. The response Content-Type travels in the result metadata. Real-browser UA when BrowserSkill is available.

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
| `EXA_API_KEY` | Enable the Exa search API channel. |
| `TAVILY_API_KEY` | Enable the Tavily search API channel. |
| `PARALLEL_API_KEY` | Enable the Parallel search API channel. |
| `PI_WEB_TOOLS_ENGINES` | Optional enabled set: `exa,tavily,parallel,google,bing,baidu,yandex`. Unset = defaults from the system language (google everywhere; zh adds bing, ru adds yandex). |

The real-browser channel uses [BrowserSkill](https://github.com/Tencent/BrowserSkill) (`bsk` CLI); install it separately.

## Notes

- **Not compatible with pi-web-access**: both register a `web_search` tool. Uninstall one of them.
- Design intent and requirements: [`SPEC.md`](SPEC.md).