# pi-web-tools 规格说明（需求定稿）

> 通用设计原则（Pi Native / LLM+Token Friendly / 提供能力 / 极简克制 / 统一视觉语法）见项目级 [`SPEC.md`](../../SPEC.md)。本文件只记录本包需求与设计意图。

## 问题陈述

Pi 内置工具（bash / read / write / find / grep / ls / edit）全是本机能力，没有任何 Web 能力。现有 web 扩展（pi-web-access）是"全家桶"：搜索 + 内容提取 + curator 浏览器交互 + GitHub clone + PDF/视频 + storage，功能过多且混淆了搜索 API 与模型 grounding。

本扩展提供两个 web 原语：**搜索**与**抓取**。其余能力（git clone、PDF、视频等）随模型能力提升交由 LLM 用通用工具自行完成；与 Pi 内置重复的不提供。

## 解决方案

两个原语工具：

- **`web_search`** — 搜索互联网，返回结果列表（title / url / snippet）。
- **`web_fetch`** — 抓取一个 URL，返回转换后的 Markdown（LLM / token friendly）。

## 工具面

### `web_search`

```
web_search(
  query: string,                          // 必填
  recency?: "day" | "week" | "month" | "year",
  allowed_domains?: string[],             // 只在这些域内搜（跨通道翻译）
  blocked_domains?: string[],             // 排除这些域（跨通道翻译）
  locale?: string,                        // BCP-47，如 "zh-CN"；默认自动推断
  engine?: "auto" | "google" | "bing" | "baidu" | "yandex",  // 默认 auto
)
→ { results: [{ title, url, snippet }], total }
```

- **无 count / 无分页**：结果量由通道自然返回；`total` 透明告知截断（LLM 见 `total > 返回数` 即知被截断，需要更多时换 query 重搜）。
- **snippet 取通道自带描述**，不 AI 生成。
- **引擎回声**：实际引擎/通道只进 `details`（UI 卡片可见），LLM 零感知。

### `web_fetch`

```
web_fetch(url: string) → { title, markdown }
```

- HTML → Markdown 转换（转化即可读、省 token）。
- **返回不含 url**：工具的定位是"了解 URL 对应页面的内容"——返回即内容（title + markdown）；重定向是 HTTP 层透明行为，LLM 引用入口 URL 即可（用户访问时自动跟随），无需回显落地 URL。
- **错误时 `error` 字段承载 HTTP 状态码**（如 `HTTP 404: Not Found` / `HTTP 403: Forbidden`）——成功时不需要 status 字段（有内容即成功）。
- **只做核心 fetch**：静态页面 HTML → Markdown。复杂抓取（带 cookies 的认证页、POST/API、二进制下载、视频流、交互页面）→ **交给 LLM 自己用 bash curl**（提供能力而非方案）。
- 不做独立缓存 / storage（即用即走）。
- 不做 PDF / 视频 / 站点导航（剪裁自 pi-web-access）。

## 通道架构

三个通道，LLM 不感知（通道 = 用户配置 + 运行时可用性自动判定，静默降级）：

| 通道 | 组成 | 成本模型 | 能力 |
|---|---|---|---|
| **search API** | Exa（MCP 零配置 + API key 双模）、Tavily、Parallel；provider 插件化（新增 = 新文件） | 免费额度优先 | 基础搜索（自然语言 query） |
| **真实浏览器（bsk）** | 驱动 google / bing / baidu | 本地免费 | 本地化、登录态、**完整引擎操作符** |
| **模型 grounding** | OpenAI 订阅内免费 / Gemini 5k 次每月免费 / Anthropic 默认禁用（$10/1k） | 按厂商订阅态动态判定 | 基础搜索（自然语言） |

**fallback 链**：免费 search API → bsk 真实浏览器 → grounding。顺序可被用户配置覆盖。

## 操作符设计（engine 门控）

LLM 对搜索操作符有先验知识（训练语料含 `site:` / `filetype:` / `intitle:` / `-` / `OR` / 引号）。因此：

- **不参数化操作符**（`filetype?: "pdf"` 是封装——把 LLM 已会的几十个操作符锁死成枚举，违背"提供能力而非方案"）。
- **不自动检测操作符**（工具层解析 query 是语义判断，连字符/冒号/引号边界易误判，且是"封装"）。
- **`engine` 显式门控**：LLM 传 `engine: "google"` → 走 bsk 真实引擎，**query 里自由写任意操作符**（先验知识直接生效）；不传（auto）→ 免费 API 链，query 自然语言。
- `engine` 的角色是"声明操作符能力需求"，不是"选 provider"——这是对"LLM 零通道感知"的有意修正。
- 结构化过滤（域名/时间/地区）走**参数**（跨通道可翻译、语义确定），操作符走 **query**（engine 门控）——各得其所。

## 本地化（locale）

- **自动推断**：query 语言检测 + 用户系统 locale/时区 → 复合推断。
- **显式覆盖**：`locale` 参数（BCP-47，如 "zh-CN" 同时编码语言 + 地区）。
- **引擎优先级按语言分组**（默认 bsk 通道的选择顺序）：

| 语言 | 引擎优先级 |
|---|---|
| 中文 | bing（中文版）> baidu > google |
| 俄语 | yandex > google > bing |
| 其他（含韩语/日语） | google > bing |

> 判据：当地使用量最大 + 实际可用性（bsk 反爬/质量）。韩国 Naver（63%）与日本 Yahoo（6.6%，底层即 Google）因单市场价值低、维护成本高而不支持，Google/Bing 兜底即可。

- **locale 落地**：google 用 `gl=CN&hl=zh-CN&lr=lang_zh-CN`；bing 用 `mkt=zh-CN`（直接吃 BCP-47）；baidu 天然中文无需设置；yandex 用 `lr=213` 等原生参数。
- **API 通道不支持 locale** → 自动 fallback 到 bsk 真实浏览器执行对应本地化搜索。

## 人机验证（captcha）处理

真实浏览器通道的已知风险：

```
google 触发人机验证
  → 自动换引擎：同 locale 按语言优先级轮换（中文：bing → baidu → google；俄语：yandex → google → bing；其他：google → bing）
  → 全部引擎都被拦 → bsk human-in-loop 兜底（弹窗请用户接管）
  → 或返回错误（用户配置层决定是否允许 human-in-loop）
```

- 换引擎**不换 locale**（保持搜索意图）。
- 静默轮换，细节进 details（"via bing (google captcha)"）。

## 错误处理与诊断

### 错误分层

- **LLM**：收到简洁错误（如 "filetype 需要真实浏览器通道"），**不含安装/配置指引**（细节不进 LLM 上下文）。
- **用户（TUI）**：看到完整诊断（原因 + 建议），展开可见全部细节（对齐统一视觉语法的折叠预览）。
- **bsk 安装**：不归本扩展——bsk 的运行报错**透传到 TUI** 显示；安装由 bsk CLI 自己负责（用户自行处理）。

### 错误计划结构

错误不是单行报错，而是结构化诊断块（对齐根 SPEC 统一视觉语法）：

- `expanded`：完整诊断（展开时 Ctrl+O 可见）
- `collapsed`：折叠预览行
- `expandHint`："... (N more lines, ctrl+o to expand)" 提示

内容包含：原因、实际通道、失败阶段（如 "bsk daemon not running / captcha blocked"）。

## 能力与路由（纯函数）

### 通道可用性检测

```ts
isChannelAvailable(channel): boolean   // key 存在且格式合法 / bsk 已装 / 订阅态判定
```

每个通道一个纯函数（可单测）。**不含占位符黑名单**（防御性机制不做）。

### 通道能力矩阵（静态表）

```ts
channelCapabilities(channel): { recency: boolean; locale: boolean; domains: boolean; operators: boolean }
```


### 路由决策（纯函数）

```ts
route(requestedCapabilities): channel | error
// 请求能力集 ∩ 通道能力集 ∩ 可用通道 → 选通道
// 无通道满足 → 显式报错（"能力 X 无可用通道"）
```

- 路由是内部实现，LLM 只感知结果或显式报错（能力缺失不静默）。
- 普通搜索（无高级能力）→ 免费 API 优先（成本优先）。

## web_fetch 行为规格

### UA 策略

```
UA 来源优先级：
1. 系统默认浏览器（xdg 检测）→ --version 读真实版本 → 标准 UA 模板构造（
   firefox: rv 匹配版本；chrome/chromium/edge: Chrome/major.0.0.0）——缓存复用
2. 默认浏览器不可用 → 探测已安装的 chrome/chromium/firefox/edge 二进制构造
3. 兜底 → 固定 FALLBACK_UA 常量（发版前 `pnpm update:ua` 用 caniuse-lite
   数据 pin 市占率最高浏览器的常用版本）
```

### 请求行为

- **输出统一格式**（对齐 Markdown for Agents 布局）：frontmatter（
  `title`/`description`/`image`，仅输出有值的字段）→ 正文 → JSON-LD（
  有则末尾 fenced `json` 块）；协商直取（`Accept: text/markdown`）与
  本地转换输出同一格式。
- **内容判定**：仅 HTML/XHTML 走 markdown 提取；其他文本响应（JSON/XML/
  纯文本等）原样返回原文（title 空——原文无 title 不编造）；二进制
  （image/audio/video 等）报错。
- **CSR 页**（壳空 + JS 渲染）：本地 headless 渲染后返回真实内容给 LLM，
  渲染不可用才回落占位——定位是 LLM friendly 抓取工具，不给占位。
- **错误规范化**：HTTP 状态/网络/超时 → `error` 字段（非抛异常）；
  超时与外部取消区分。
- **无第三方 fallback**（不引入 r.jina.ai 类中转服务）；复杂抓取
  （认证/交互页）归 LLM 自行用 bash curl 等。

## 配置

- API key 环境变量：`EXA_API_KEY` / `TAVILY_API_KEY` / `PARALLEL_API_KEY`（与 pi-web 生态同名对齐）。
- 通道序覆盖（可选）：`PI_WEB_TOOLS_CHANNELS`。
- 本地化无环境变量（纯自动 + `locale` 参数覆盖）。

## 不在此范围

- **count / 分页参数**：结果量通道自然返回 + `total` 透明。
- **provider 参数**：通道选择对 LLM 隐藏（用户配置层）。
- **操作符参数化 / 自动检测**：操作符归 query，engine 门控。
- **独立 fetch 缓存 / storage**（pi-web 的 get_search_content 类机制）。
- **curator 浏览器交互 / cookie 借用 / GitHub clone / PDF 提取 / 视频理解**。
- **SSRF 防护**：fetch 是原语，与 bash curl 等价，安全责任在使用方（不为防误用加机制）。
- **地域/语言环境变量**：本地化自动行为 + `locale` 参数。
