# pi-web-tools

Pi 的 Web 原语——`web_search` + `web_fetch`。

- **`web_search`** — 搜索互联网。请求按保险丝顺序路由过多个 HTTP 搜索通道——TinyFish（需 key，30 req/min）→ Exa → Tavily → Firecrawl（Google 后端；keyless 优先，key 只作升档）——失败自动降级。五个参数：`query`、`recency?`、`allowed_domains?`、`blocked_domains?`、`locale?`。结果语言跟随 query 语言；`locale` 是显式的市场/语言加权。没有 engine 参数——路由对 LLM 完全不可见。
- **`web_fetch`** — 抓取 URL：HTML 页面默认转为 Markdown（LLM / token friendly）；传 `raw: true` 获取原始 HTML（不做任何包装）。非 HTML（SVG/JSON/文本等一切文本）一律原样返回；超大内容截断并给出 /tmp 全文路径（非网页内容不内联预览）；响应 Content-Type 随结果元数据返回；图片（`image/*`，SVG 除外）以多模态 image block 返回——TUI 内联渲染、模型直接消费。直取层唤醒系统 `curl` CLI（身份 = 这台机器的真 curl：TLS/头部/HTTP1.1 全原生，零伪装），无 curl 时退化钉死 curl UA 的浅模拟；反爬/JS 渲染页自动走渲染保险丝——`firecrawl scrape`（目前无需 key）→ `tinyfish fetch`（需 key）——共享 45s 预算，且只在渲染真能改变答案时才进（404/410、付费墙、额度耗尽、法务封锁都不进）。

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

### key 从哪来

两个来源，前者优先：

1. **环境变量** —— `TINYFISH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`FIRECRAWL_API_KEY`。CI、脚本、已经导出过的场景用它。
2. **`<agent 目录>/web-tools.json`** —— 不想改 shell 配置就写这个文件（默认 `~/.pi/agent/web-tools.json`）：

```json
{ "tinyfish": "…", "exa": "…", "tavily": "…", "firecrawl": "…" }
```

文件不存在、读不了、JSON 坏了，都等于「没配」——与变量未设置完全一致，不会报错。本扩展从不写这个文件。

里面是明文 key，请自己收好：`chmod 600 ~/.pi/agent/web-tools.json`，放在自己的家目录，别放进共享或同步目录。key 是用户级的，所以没有项目级版本（也就不会有人把它提交进仓库）。

pi 没有扩展专用的密钥存储（`auth.json` 属于 LLM provider）；「环境变量优先 + 自己的 JSON 文件兜底」是 pi 生态里同类扩展收敛出的做法。

### 环境变量

| 变量 | 含义 |
|---|---|
| `TINYFISH_API_KEY` | 启用 TinyFish 通道（30 req/min）。2026-11 起其 API 无 key 返回 401，搜索与渲染皆然。 |
| `EXA_API_KEY` | Exa keyed 模式（全参数）。不设置时 Exa 仍以 MCP keyless 运行（裸 query，3 qps / 150 calls 每天）。 |
| `TAVILY_API_KEY` | 启用 Tavily 通道（免费 1,000 credits/月）。 |
| `FIRECRAWL_API_KEY` | Firecrawl keyed 升档。不设置时通道以 keyless 运行（免费，per-IP 每日上限）。keyless 额度没用完前绝不会动 key——该池与 pi-read-doc 的 OCR 共享。 |

零 key 也能跑：keyless Exa + keyless Firecrawl（两者目前都接受无 key 请求；但两家都没承诺这一点——真变了，通道会自动跳过，卡片上会写明）。没有要装的二进制——所有通道都是 HTTP API。真实浏览器通道（BrowserSkill/`bsk`）曾经是两条链的链尾，现已移除：兜底若绑死第三方 CLI 的参数形状，对方一改版就断，而链尾恰恰没有下一跳。

**隐私**：主路径不中转——由本机 `curl` 直取。渲染保险丝会中转：页面在反爬墙后面、或只有浏览器才能渲染时，**目标 URL 会发给 Firecrawl**（有 key 时也可能是 TinyFish）换回内容。这是「拿到一个纯 HTTP 拿不到的页面」的代价，默认开启，才谈得上「装上就能用」。不接受的话，就只用能直取的页面。

## 注意

- **与 pi-web-access 不兼容**：两者都注册 `web_search` 工具。需卸载其一。
- 设计意图与需求见 [`SPEC.md`](SPEC.md)。