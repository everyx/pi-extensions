# pi-read-doc

[English](README.md) | [中文](README.zh.md)

Enhanced `read` for office documents — Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV via [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) → clean Markdown.

- **14 formats** in one Rust engine (4.4ms median), GFM with tables/formulas/footnotes.
- **Header-only** folding (read-like) — collapsed shows only `read_doc <path>`, `Ctrl+O` expands to full.
- **Auto fallback** (non-office files read as raw utf-8 text): text PDF locally → `needsOcr` scanned pages → `hosted` (Firecrawl Parse, 2 qps, 1k pages/month — charged per OCR'd page, local-month reset, at `~/.pi/read-doc.json`) → `rapidocr` (local `python-rapidocr`, `pdf` only).
- **Manual enable**: not in `defaultActiveToolNames`; add to `settings.json: defaultTools` or `pi --tools read_doc`.

```bash
pi install npm:@everyx/pi-read-doc
# then in settings.json: "defaultTools": ["read","read_doc",...]
```

## Configuration

Everything is optional — the extension works with zero setup (text PDFs and
all office formats convert locally).

| Env var | Effect |
|---|---|
| `FIRECRAWL_API_KEY` | Lifts the keyless tier of **hosted OCR** — scanned pages (`needsOcr`) go to Firecrawl Parse instead of falling back to local `rapidocr` (pdf only). Keyless works out of the box with per-IP rate limits; setting the key raises them. The keyed pool is shared with pi-web-tools search. |

```bash
export FIRECRAWL_API_KEY="fc-..."   # or add it to your launcher's env file
```

Scanned-page OCR is self-capped at 1,000 pages/month locally
(`~/.pi/read-doc.json`, calendar-month reset) — a self-defense budget, not an
upstream quota; any price overage stops at that line.

