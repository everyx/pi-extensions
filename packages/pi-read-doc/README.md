# pi-read-doc

[English](README.md) | [中文](README.zh.md)

Enhanced `read` for office documents — Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV via [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) → clean Markdown.

- **One Rust engine** for all of the above (4.4ms median), GFM with tables/formulas/footnotes.
- **Header-only** folding (read-like) — collapsed shows only `read_doc <path>`, `Ctrl+O` expands to full.
- **OCR engines** (non-office files read as raw utf-8 text): text PDFs convert locally; pages that need OCR (`needsOcr`) go to the engines you allow, in the order you list them — `rapidocr,firecrawl` by default: the local engine reads what it can, and the cloud one is the fallback. Pick a single engine and it is the only one used: `PI_READ_DOC_OCR_ENGINE=rapidocr` never uploads anything.
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
| `PI_READ_DOC_OCR_ENGINE` | **Which OCR engines may read a scanned page, in order** (`rapidocr,firecrawl` by default: local first, cloud as the fallback). Each name is a real engine, and only one of them sends your document anywhere: <br>· `firecrawl` — Firecrawl Parse, keyless, nothing to install. It uploads the **whole document** (Parse has no page selection, so it is not only the scanned pages). <br>· `rapidocr` — this machine: `poppler` (`apt install poppler-utils` · `brew install poppler` · `pacman -S poppler`) plus the `rapidocr` Python package (`pip install rapidocr`). Nothing leaves the machine. <br>· `off` — no OCR at all. <br>Examples: `rapidocr` (never upload), `rapidocr,firecrawl` (local first), `firecrawl` (cloud only). A value that is not one of these is **refused**, not replaced with the default. |
| `FIRECRAWL_API_KEY` | Lifts the keyless tier of the `firecrawl` engine (per-IP rate limits become plan limits). Keyless works out of the box; the keyed pool is shared with pi-web-tools search. |
| `PI_READ_DOC_OCR_TIMEOUT_MS` | How long **one local OCR run** (`rapidocr`) may take, in ms (default `120000`). The knob is wall clock, not page count — a scanned page costs seconds, and how many depends on how much text it carries. Pages not reached come back labelled `not read: time budget`, so a partial result is never mistaken for a whole one. |

```bash
export FIRECRAWL_API_KEY="fc-..."   # or add it to your launcher's env file
```

The `firecrawl` engine is not budgeted by a local estimate: when Firecrawl
reports a real limit (out of credits, or the keyless daily cap), it is parked
until it makes sense to ask again (`~/.pi/read-doc.json`) and the next engine in
your list takes over. The card header says so, and deleting that file resumes at
once.

`rapidocr` is bounded by wall clock (default 2 minutes, ~2–3s per page on CPU);
pages it does not reach come back as a labelled block (`not read: time budget`,
`not read: timeout`) rather than being dropped silently.

**Two different networks.** "Local" describes where your *document* goes, not
everything the machine does: `rapidocr` downloads its models on the first OCR
run (then works offline), and either way the text that comes out is sent to
whichever model provider pi is configured with.

## What the model sees

Documents anydoc can convert come back as plain markdown. Pages that had to be
read from images come back as a JSON array of page blocks:

```json
[
  { "pages": "1-2", "text": "# Contract\n..." },
  { "pages": "3", "text": "SIGNATURE PAGE PROBE",
    "image": "/tmp/pi-read-doc-8f2a/page-9c1f-3.jpg" }
]
```

`text` holds what the engine read (our confidence floor — `0.5`, documented, not invisible — decides which lines count as text);
`note` appears only when the reader cannot see the fact for itself: a page that
held no text, or why a page is missing. It never repeats that a block was read
from an image — the `image` field already says that. The `image` is the original
page, kept so the model can look when a number or name matters. It is a 1500px
copy (~2300 tokens per read), not the 200dpi render used for OCR.
