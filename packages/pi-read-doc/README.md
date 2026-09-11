# pi-read-doc

[English](README.md) | [中文](README.zh.md)

Enhanced `read` for office documents — Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV via [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) → clean Markdown.

- **One Rust engine** for all of the above (4.4ms median), GFM with tables/formulas/footnotes.
- **Header-only** folding (read-like) — collapsed shows only `read_doc <path>`, `Ctrl+O` expands to full.
- **Auto fallback** (non-office files read as raw utf-8 text): text PDFs locally → `needsOcr` pages → `hosted` (Firecrawl Parse, 2 qps; parked automatically once the service reports its limits) → local OCR (poppler + `rapidocr`).
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
| `FIRECRAWL_API_KEY` | Lifts the keyless tier of **hosted OCR** — scanned pages (`needsOcr`) go to Firecrawl Parse instead of falling back to local `rapidocr` (pdf only). Keyless works out of the box with per-IP rate limits; setting the key raises them. The keyed pool is shared with pi-web-tools search. Note that Parse has no page selection: the **whole document** is uploaded, not only the scanned pages. |
| *(local OCR)* | **Local OCR** — the last rung of the chain — needs two things on the machine: `poppler` (`apt install poppler-utils` · `brew install poppler` · `pacman -S poppler`) and the `rapidocr` Python package (`pip install rapidocr`). It runs when hosted OCR is unavailable (or once the hosted gate has parked it); without them a scanned PDF fails with a clear error. Models download on the first OCR run, then it works offline. |
| `PI_READ_DOC_OCR_TIMEOUT_MS` | How long **one local OCR recovery** may take, in ms (default `120000`). The knob is wall clock, not page count — a scanned page costs seconds, and how many depends on how much text it carries. Pages not reached come back labelled `not read: time budget`, so a partial result is never mistaken for a whole one. |

```bash
export FIRECRAWL_API_KEY="fc-..."   # or add it to your launcher's env file
```

Hosted OCR is not budgeted by a local estimate: when Firecrawl reports a
real limit (out of credits, or the keyless daily cap), hosted is parked until
it makes sense to ask again (`~/.pi/read-doc.json`) and the read falls back to
local OCR. The card header says so, and deleting that file resumes at once.

Local OCR is bounded by wall clock (default 2 minutes, ~2–3s per page on CPU);
pages it does not reach come back as a labelled block (`not read: time budget`,
`not read: timeout`) rather than being dropped silently.

## What the model sees

Documents anydoc can convert come back as plain markdown. Pages that had to be
read from images come back as a JSON array of page blocks:

```json
[
  { "pages": "1-2", "text": "# Contract\n..." },
  { "pages": "3", "text": "SIGNATURE PAGE PROBE",
    "image": "/tmp/pi-read-doc-8f2a/page-9c1f-3.jpg",
    "note": "OCR — verify against image" }
]
```

`text` holds what the engine read (our confidence floor — `0.5`, documented, not invisible — decides which lines count as text);
`note` says what you should know about the block — that it was machine-read, that
a page held no text, or why a page is missing. The `image` is the original page,
kept so the model can look when a number or name matters. It is a 1500px copy
(~2300 tokens per read), not the 200dpi render used for OCR.
