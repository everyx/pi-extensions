# pi-read-doc

[English](README.md) | [中文](README.zh.md)

`read` 的 Office 扩展——Word/Excel/PowerPoint/PDF/ODT/RTF/EPUB/CSV 经 [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) 转干净 Markdown。

- **单 Rust 引擎** 覆盖以上全部格式（中位 4.4ms），GFM 表格/公式/脚注归一。
- **Header-only** 折叠（同 `read`）——折叠仅 `read_doc <path>`，`Ctrl+O` 展开全量。
- **OCR 引擎可选**：文本 PDF 本地直转；需要 OCR 的页（`needsOcr`）交给你允许的引擎，按你列的顺序试——默认 `rapidocr,firecrawl`：本地能读就本地读，读不了才回落云端。只写一个就只用那一个：`PI_READ_DOC_OCR_ENGINE=rapidocr` 时文档永不外传。
- **手动启用**：不进 `defaultActiveToolNames`，`settings.json: defaultTools` 或 `pi --tools read_doc` 按需开。

```bash
pi install npm:@everyx/pi-read-doc
```

## 配置

全部可选——零配置即可用（文本 PDF 与全部 Office 格式本地转换）。

| 环境变量 | 作用 |
|---|---|
| `PI_READ_DOC_OCR_ENGINE` | **允许哪些 OCR 引擎来读扫描页，按顺序**（默认 `rapidocr,firecrawl`：本地优先，云端兜底）。每个值都是一个真实引擎，其中只有一个会把文档送出去：<br>· `firecrawl` —— Firecrawl Parse，免 key、零安装；但它上传的是**整份文档**（Parse 不支持按页选择，不只是扫描页）。<br>· `rapidocr` —— 本机：`poppler`（`apt install poppler-utils` · `brew install poppler` · `pacman -S poppler`）加 Python 包 `rapidocr`（`pip install rapidocr`）。文档不出本机。<br>· `off` —— 完全不做 OCR。<br>例：`rapidocr`（永不外传）、`rapidocr,firecrawl`（本地优先）、`firecrawl`（只用云端）。**取值非法一律拒绝**，不会静默换回默认。 |
| `FIRECRAWL_API_KEY` | 提升 `firecrawl` 引擎的额度（per-IP 限速 → 套餐额度）。不设也开箱可用；keyed 池与 pi-web-tools 搜索共享。 |
| `PI_READ_DOC_OCR_TIMEOUT_MS` | **单次本地 OCR 恢复**最多花多久（毫秒，默认 `120000`）。旋钮是**时间不是页数**——扫描页耗时以秒计，而具体几秒取决于那页有多少文字。没轮到的页会以 `not read: time budget` 标注返回，部分结果不会被当成完整文档。 |

```bash
export FIRECRAWL_API_KEY="fc-..."   # 或加进你的启动器 env 文件
```

`firecrawl` 引擎不做本地估算：当 Firecrawl 报告真实上限（额度用尽，或免费层当日额度到顶），就停摆到重新值得询问为止（`~/.pi/read-doc.json`），期间由你列表里的下一个引擎接手。卡片头部会说明原因，删掉该文件即可立刻恢复。

`rapidocr` 以墙钟时间为界（默认 2 分钟，CPU 上约 2–3 秒/页）；没轮到的页会以带标注的块返回（`not read: time budget`、`not read: timeout`），不会静默丢弃。

**两个不同的"网络"。** "本地"说的是你的**文档**去了哪里，不是机器什么都不联网：`rapidocr` 首次 OCR 会下载模型（之后可离线）；无论走哪个引擎，识别出来的文字仍会发给 pi 配置的模型。

## 模型看到什么

anydoc 能转换的文档，返回纯 markdown。需要从图像读取的页，返回 JSON 页块数组：

```json
[
  { "pages": "1-2", "text": "# 合同\n…" },
  { "pages": "3", "text": "SIGNATURE PAGE PROBE",
    "image": "/tmp/pi-read-doc-8f2a/page-9c1f-3.jpg" }
]
```

`text` 是引擎真实识别到的内容（哪些行算文字由我们的置信度下限 `0.5` 决定——这是显式规则，不是隐形过滤）；`note` 只在「读者自己看不出来」时出现：这一页没有文字、或者为什么缺页。它不会重复告诉你「这段来自图片」——`image` 字段已经说了。`image` 是原始页图，留给模型在数字/名称要紧时回看；它是 1500px 的观察副本（约 2300 token），不是 OCR 用的 200dpi 渲染图。
