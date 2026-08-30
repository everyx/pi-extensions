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

## 配置

全部可选——零配置即可用（文本 PDF 与全部 Office 格式本地转换）。

| 环境变量 | 作用 |
|---|---|
| `FIRECRAWL_API_KEY` | 提升 **hosted OCR** 的免费层额度——扫图页（`needsOcr`）走 Firecrawl Parse，而非回落本地 `rapidocr`（仅 pdf）。keyless 开箱可用（per-IP 限速），设 key 升额；keyed 池与 pi-web-tools 搜索共享。 |

```bash
export FIRECRAWL_API_KEY="fc-..."   # 或加进你的启动器 env 文件
```

扫图 OCR 本地自限 1000 页/月（`~/.pi/read-doc.json`，日历月重置）——成本自卫预算，非上游额度；超支也在该线停下。
