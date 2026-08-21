# pi-web-tools

Pi 的 Web 原语——`web_search` + `web_fetch`。

- **`web_search`** — 搜索互联网。优先免费 search API（Exa / Tavily / Parallel），其次真实浏览器搜索（Google / Bing / 百度 / Yandex，经 BrowserSkill）。引擎默认集跟随系统语言（如中文系统补 Bing，走 cn.bing.com）；要本地化结果时显式传 `locale`；显式指定引擎时可用完整搜索操作符语法。
- **`web_fetch`** — 抓取 URL：HTML 页面默认转为 Markdown（LLM / token friendly）；传 `raw: true` 获取原始 HTML（按 content-type 包代码块）。非 HTML（JSON/XML/文本）一律原样返回。BrowserSkill 可用时使用真实浏览器 UA。

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
| `EXA_API_KEY` | 启用 Exa search API 通道。 |
| `TAVILY_API_KEY` | 启用 Tavily search API 通道。 |
| `PARALLEL_API_KEY` | 启用 Parallel search API 通道。 |
| `PI_WEB_TOOLS_ENGINES` | 可选启用集：`exa,tavily,parallel,google,bing,baidu,yandex`。未设置 = 按系统语言默认（google 全语言；zh 补 bing，ru 补 yandex）。 |

真实浏览器通道使用 [BrowserSkill](https://github.com/Tencent/BrowserSkill)（`bsk` CLI），需另行安装。

## 注意

- **与 pi-web-access 不兼容**：两者都注册 `web_search` 工具。需卸载其一。
- 设计意图与需求见 [`SPEC.md`](SPEC.md)。