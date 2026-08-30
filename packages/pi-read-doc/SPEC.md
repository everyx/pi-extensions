# pi-read-doc — design intent

Enhanced `read` for office documents: `read_doc <path>` returns clean Markdown.

## 工具面

- One tool: `read_doc` (`{ path }`). Not in `defaultActiveToolNames`; enable via `settings.json: defaultTools` or `pi --tools`.
- Header-only folding (read-like): collapsed shows `read_doc <path>`, expand reveals full Markdown.
- Non-office files fall back to raw utf-8 text (`convertedVia: "raw"`) — binary files will garble; prefer `read`.

## 转换链路（fallback 顺序）

1. anydoc (`@firecrawl/anydoc`, Rust) — 21 office formats local, no network.
2. anydoc:hosted (Firecrawl Parse, keyless) — only for scanned pages needing OCR (`needsOcr`), 2 qps.
3. rapidocr (local `python-rapidocr`, official `from rapidocr import RapidOCR`; python/python3 双试是二进制名枚举) — pdf only.

## 配额（成本自卫，非上游额度）

- `QUOTA_LIMIT = 1000` 页/月，按 **OCR 页数**计费（每文档 `pages || 1`），gate 是 `used < limit`。
- 月界用**本地日历**（用户可感知的月度体验）；上游 Firecrawl 按订阅周年日重置、不可对齐，本地月只是固定近似。
- 持久化 `~/.pi/read-doc.json`（`homedir() + CONFIG_DIR_NAME`，默认 `.pi`；**不跟随** PI_CODING_AGENT_DIR——quota 是用户级消费计数，agent dir 可指向沙箱/临时目录，计数不应随行）：`{ quota: { updatedAt: "YYYY-MM-DD", used } }`。
- 限流内部模块 `rate-limit.ts`（sleep-before 语义，与 pi-web-tools 的 sleep-after 有意区分，不合并）。