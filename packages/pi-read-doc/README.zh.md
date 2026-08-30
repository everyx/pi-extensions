# pi-read-doc

[English](README.md) | [中文](README.zh.md)

`read` 的 Office 扩展——Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV 经 [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) 转干净 Markdown。

- **14 格式** 单 Rust 引擎（中位 4.4ms），GFM 表格/公式/脚注归一。
- **Header-only** 折叠（同 `read`）——折叠仅 `read_doc <path>`，`Ctrl+O` 展开全量。
- **自动回退**：文本 PDF 本地直转；扫图页 `needsOcr` → `hosted`（Firecrawl Parse，2 qps，1k/月落 `~/.pi/read-doc.json`）→ `rapidocr`（本地 `python-rapidocr`，仅 `pdf`）。
- **手动启用**：不进 `defaultActiveToolNames`，`settings.json: defaultTools` 或 `pi --tools read_doc` 按需开。

```bash
pi install npm:@everyx/pi-read-doc
```
