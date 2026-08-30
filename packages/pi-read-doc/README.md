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

