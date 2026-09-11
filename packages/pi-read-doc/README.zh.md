# pi-read-doc

[English](README.md) | [中文](README.zh.md)

`read` 的 Office 扩展——Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV 经 [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) 转干净 Markdown。

- **单 Rust 引擎** 覆盖以上全部格式（中位 4.4ms），GFM 表格/公式/脚注归一。
- **Header-only** 折叠（同 `read`）——折叠仅 `read_doc <path>`，`Ctrl+O` 展开全量。
- **自动回退**：文本 PDF 本地直转；扫图页 `needsOcr` → `hosted`（Firecrawl Parse，2 qps；服务报告额度上限后自动停摆）→ 本地 OCR（poppler + `rapidocr`）。
- **手动启用**：不进 `defaultActiveToolNames`，`settings.json: defaultTools` 或 `pi --tools read_doc` 按需开。

```bash
pi install npm:@everyx/pi-read-doc
```

## 配置

全部可选——零配置即可用（文本 PDF 与全部 Office 格式本地转换）。

| 环境变量 | 作用 |
|---|---|
| `FIRECRAWL_API_KEY` | 提升 **hosted OCR** 的免费层额度——扫图页（`needsOcr`）走 Firecrawl Parse，而非回落本地 `rapidocr`（仅 pdf）。keyless 开箱可用（per-IP 限速），设 key 升额；keyed 池与 pi-web-tools 搜索共享。 注意 Parse 不支持按页选择：**整份文档**都会被上传，不只是扫描页。 |
| *（本地 OCR）* | **本地 OCR** ——链路最后一环——需要机器上装两样：`poppler`（`apt install poppler-utils` · `brew install poppler` · `pacman -S poppler`）与 Python 包 `rapidocr`（`pip install rapidocr`）。它在 hosted OCR 不可用（或已被停摆）时接手；没装时扫描件就是清晰报错。模型在首次 OCR 时下载，之后可离线。 |
| `PI_READ_DOC_OCR_TIMEOUT_MS` | **单次本地 OCR 恢复**最多花多久（毫秒，默认 `120000`）。旋钮是**时间不是页数**——扫描页耗时以秒计，而具体几秒取决于那页有多少文字。没轮到的页会以 `not read: time budget` 标注返回，部分结果不会被当成完整文档。 |

```bash
export FIRECRAWL_API_KEY="fc-..."   # 或加进你的启动器 env 文件
```

托管 OCR 不做本地估算：当 Firecrawl 报告真实上限（额度用尽，或免费层当日额度到顶），就停摆到重新值得询问为止（`~/.pi/read-doc.json`），期间读取走本地 OCR。卡片头部会说明原因，删掉该文件即可立刻恢复。

本地 OCR 以墙钟时间为界（默认 2 分钟，CPU 上约 2–3 秒/页）；没轮到的页会以带标注的块返回（`not read: time budget`、`not read: timeout`），不会静默丢弃。

## 模型看到什么

anydoc 能转换的文档，返回纯 markdown。需要从图像读取的页，返回 JSON 页块数组：

```json
[
  { "pages": "1-2", "text": "# 合同\n…" },
  { "pages": "3", "text": "SIGNATURE PAGE PROBE",
    "image": "/tmp/pi-read-doc-8f2a/page-9c1f-3.jpg",
    "note": "OCR — verify against image" }
]
```

`text` 是引擎真实识别到的内容（哪些行算文字由我们的置信度下限 `0.5` 决定——这是显式规则，不是隐形过滤）；`note` 说明这一块该知道什么——是机器识别的、这页没有文字、或者为什么缺页。`image` 是原始页图，留给模型在数字/名称要紧时回看；它是 1500px 的观察副本（约 2300 token），不是 OCR 用的 200dpi 渲染图。
