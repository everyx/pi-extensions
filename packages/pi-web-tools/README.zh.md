# pi-web-tools

Pi 的 Web 原语——`web_search` + `web_fetch`。

- **`web_search`** — 搜索互联网。请求按保险丝顺序路由过多个 HTTP 搜索通道——TinyFish（免费无限）→ Exa → Tavily → Firecrawl（Google 后端；keyless 优先，key 只作升档）——失败自动降级；真实浏览器引擎（Google，中文走百度，经 BrowserSkill）是最后一把无 key 保险丝。五个参数：`query`、`recency?`、`allowed_domains?`、`blocked_domains?`、`locale?`。结果语言跟随 query 语言；`locale` 是显式的市场/语言加权。没有 engine 参数——路由对 LLM 完全不可见。
- **`web_fetch`** — 抓取 URL：HTML 页面默认转为 Markdown（LLM / token friendly）；传 `raw: true` 获取原始 HTML（不做任何包装）。非 HTML（SVG/JSON/文本等一切文本）一律原样返回；超大内容截断并给出 /tmp 全文路径（非网页内容不内联预览）；响应 Content-Type 随结果元数据返回；图片（`image/*`，SVG 除外）以多模态 image block 返回——TUI 内联渲染、模型直接消费。UA 从系统默认浏览器解析（xdg 探测 + 真实 `--version`，结果缓存）。

两个原语，别无冗余——无内容存储、无 curator、无 PDF/视频提取。

## 安装

```bash
pi install npm:@everyx/pi-web-tools
```

## 用法

```
搜索 pi 扩展 API 的文档
```

```
抓取 https://github.com/earendil-works/pi/blob/main/README.md 并总结
```

## 配置

| 变量 | 含义 |
|---|---|
| `TINYFISH_API_KEY` | 启用 TinyFish 通道（免费无限量，30 req/min）——主力通道。 |
| `EXA_API_KEY` | Exa keyed 模式（全参数）。不设置时 Exa 仍以 MCP keyless 运行（裸 query，3 qps / 150 calls 每天）。 |
| `TAVILY_API_KEY` | 启用 Tavily 通道（免费 1,000 credits/月）。 |
| `FIRECRAWL_API_KEY` | Firecrawl keyed 升档。不设置时通道以 keyless 运行（免费，per-IP 每日上限）。keyless 额度没用完前绝不会动 key——该池与 pi-read-doc 的 OCR 共享。 |

零 key 也能跑：keyless Exa + keyless Firecrawl，后面还有真实浏览器保险丝。真实浏览器通道使用 [BrowserSkill](https://github.com/Tencent/BrowserSkill)（`bsk` CLI），需另行安装。

## 注意

- **与 pi-web-access 不兼容**：两者都注册 `web_search` 工具。需卸载其一。
- 设计意图与需求见 [`SPEC.md`](SPEC.md)。