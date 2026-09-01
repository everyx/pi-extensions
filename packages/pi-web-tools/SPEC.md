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
  locale?: string,                        // BCP-47；显式的市场/语言加权
)
→ { results: [{ title, url, snippet, pageAge?, author? }] }   // pageAge/author 通道自带才带
```

**参数集 = 四通道意图交集 + locale 覆盖旋钮**（逐参数对照四家官方 API 核定）：
query/recency/domains 为 4/4 硬交集（exa 的 recency 用 `startPublishedDate = now - 窗` 换算）；
locale 是唯一的 best-effort 成员——地区码 4/4 原生、语言码 2/4 原生 + query 语言天然补齐。
**无 engine / 无 count / 无分页**：路由是实现细节，LLM 只表达意图。

- **无 count / 无分页**：结果量由通道自然返回（内部常量）；无 `total`（通道不报告总数，不编造）。
- **snippet 取通道自带描述**，不 AI 生成。
- **通道回声**：实际通道（bsk 时含引擎）只进 `details`（UI 卡片可见），LLM 零感知。
- **locale 双通道，工具不猜测**：结果语言天然跟随 query 语言（LLM 写 query 时已在表达 locale 意图）；`locale` 参数是显式覆盖（要"英文关键词 + 中文结果"这类 query 语言盖不住的需求时用）。工具不做语言推断、不改写请求——LLM 说什么发什么。

### `web_fetch`

```
web_fetch(url: string, raw?: boolean) → { title, content }
```

- **数据纯净**：`content` 是工具的返回数据——抓到什么给什么，永不装饰
  （围栏会改写载荷边界且遇内嵌 ``` 破防）。形状由 `contentType` 字段自描述
  （响应 Content-Type 原文），不靠内容里的标注语法。
- 参数 `raw` 表达请求意图（默认 false = 要易读版；true = 要原始）。
  HTML（raw: false）→ 转 Markdown（转化即可读、省 token）；HTML
  （raw: true）→ 原始源码；非 HTML（SVG/JSON/YAML/CSV/纯文本……都是文本）
  无论 raw 取值一律原样返回——markdown/raw 只在 HTML 页面有区分，
  非 HTML 天生是 raw。
- **返回不含 url**：工具的定位是"了解 URL 对应页面的内容"——返回即内容（title + content）；重定向是 HTTP 层透明行为，LLM 引用入口 URL 即可（用户访问时自动跟随），无需回显落地 URL。
- **错误时 `error` 字段承载 HTTP 状态码**（如 `HTTP 404: Not Found` / `HTTP 403: Forbidden`）——成功时不需要 status 字段（有内容即成功）。
- **只做核心 fetch**：静态页面 HTML → Markdown。复杂抓取（带 cookies 的认证页、POST/API、二进制下载、视频流、交互页面）→ **交给 LLM 自己用 bash curl**（提供能力而非方案）。
- 不做独立缓存 / storage（即用即走）。
- 不做 PDF / 视频 / 站点导航（剪裁自 pi-web-access）。

## 通道架构

四条 HTTP 通道按**免费额度从大到小**排成保险丝链，bsk 是链尾的无 key 保险丝（非平级通道）。可用性 = 环境事实（key 有无 / bsk CLI），零配置、零系统语言探测：

| 通道 | 免费额度 | key 缺省时 |
|---|---|---|
| **TinyFish** | 无限（30 req/min） | 不可用（key 必需，免费注册） |
| **Exa** | MCP keyless（3 qps / 150 calls/day，仅裸 query） | keyless 运行 |
| **Tavily** | 1,000 credits/月 | 不可用 |
| **Firecrawl** | keyless（per-IP 每日上限，Google 后端） | keyless 运行 |
| **bsk 保险丝** | 本地免费（无 key 概念） | 引擎按 locale 挑（zh→baidu，否则 google） |

**免费层优先、key 升级**是全链统一模式：exa 无 key 走 MCP（`exaSupports` 把带过滤器的请求让给后续通道）、firecrawl keyless 429 才动 `FIRECRAWL_API_KEY`（该池与 pi-read-doc 的 OCR 共享，搜索尽量不碰）。

**fallback 链**：tinyfish → exa → tavily → firecrawl → bsk。链上错误静默降级到下一通道；全灭才报错（failures 进 details）。bsk 是额度尽/无 key 环境的最终兜底——它的独特价值是不消耗任何 API 额度。

**bsk 结果提取**：排除付费广告（adurl/data-text-ad/b_ad 等）与**引擎生成的 AI 总结**（Google AI Overview、Bing AI summary、百度 AI 搜索——ai-*/data-ai-* 标记）——结果列表只留真实来源条目。

## 操作符（query 原样透传）

LLM 对搜索操作符有先验知识（`site:` / `filetype:` / `-` / `OR` / 引号）。因此：

- **不参数化操作符**（`filetype?: "pdf"` 是封装——把 LLM 已会的几十个操作符锁死成枚举）。
- **不自动检测、不改写**：query 原样透传给通道。Google 后端通道（firecrawl、bsk）原生兑现操作符；语义通道（exa）把操作符当文本——这是通道间的真实差异，由 failover 与结构化参数（allowed/blocked_domains 即 `site:` 的结构化形态）兜住，不对 LLM 承诺。
- 结构化过滤（域名/时间/地区）走**参数**（跨通道可翻译、语义确定），操作符归 **query**（原生处生效）——各得其所。

## 本地化（locale）

- **意图**："偏好这个语言/地区的结果"。两个表达通道，工具不推断：query 语言（主，决定结果语言）+ `locale` 参数（副，显式市场/语言加权——覆盖"英文关键词要中文源"这类 query 语言盖不住的需求）。
- **参数级落地**（`parseLocale`：region 缺省时按语言补常用市场，ja→JP 等）：

| 通道 | 映射 |
|---|---|
| TinyFish | `language` + `location`（官方支持互相自动解析） |
| Exa（keyed） | `userLocation`（官方 Bing 迁移指南：mkt/cc 等价物）；keyless 无此参数 |
| Tavily | `language`（boost 模式，不开硬过滤）+ `country`（ISO → 官方国家名枚举，CN→china） |
| Firecrawl | `country`（ISO 码；不碰 `location` 字符串——官方文档对两者同设自相矛盾） |
| bsk | 引擎挑选：zh → baidu，否则 google（google 再落 gl/hl/lr） |

- **bsk 的 recency 仅 google（tbs）**：baidu 无时效参数——请求 recency 且 locale 指向 baidu 时**显式报错**而非静默丢弃（SPEC: 能力缺失不静默）。更换 locale 可绕过。
- **bsk 的 domains 翻译为 `site:` / `-site:`**（追加进 query）：google 完整；baidu 基本支持（自家平台过滤不彻底属引擎限制）。
- **俄语（yandex）已移除**：单一市场价值低、维护成本高；ru 语 query 走 google。

## 人机验证（captcha）处理

真实浏览器通道的已知风险：引擎触发人机验证 → 检测到 captcha 特征（`captcha / not a robot / automated requests`）→ **如实报错**（含引擎名），无 human-in-loop（bsk 无此 API）。bsk 是链尾——报错即全链失败，由 LLM 决定下一步（改写 query / 传 locale 重试）。

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

## 能力与路由

```ts
candidatesFor(params, channels): SearchChannel[]          // 链序 ∩ 可用（key/CLI）∩ 能力（supports）
searchFuse(params, channels, { signal, onAttempt }): Outcome   // walk：failover · 错误累积 · 末错入 LLM
```

- 每通道一个 `available()`（key 非空 / bsk CLI 懒探测并缓存）+ `supports(params)`（能力门控——keyless Exa 不能兑现过滤器/.locale 时**跳过该通道**而非静默丢参数：SPEC 能力缺失不静默）。
- 路由按链序 failover，错误累积进 details.failures；全灭才对 LLM 报错。
- 注册表在 search/channels.ts（每通道一个自描述对象：available/supports/search/echo，纯组装）；walk 逻辑在 search/fuse.ts（fake 通道可单测）；HTTP 细节在各适配器。加通道 = 一个适配器文件 + 注册表一条 + `ChannelId` union 一个成员（类型系统强制）。

## web_fetch 行为规格

### 传输层（2026-08 三改：伪装层尽弃 → 唤醒系统 curl）

```
主传输：spawn 系统 curl（-sS -L --max-redirs 5 --compressed，-D 捕响应头，
stdout 流式入 64MB cap）。身份 = 该机器真实的 curl：TLS/UA/Accept: */*/
HTTP/1.1 全部原生，零伪装零调优——"你就是这台机器上用 curl 抓网页的人"。
不装 Chrome 的理由：Node 的 TLS 指纹无法对齐 Chrome（ext 乱序/记录尺寸
OpenSSL 写死），反而"Chrome 声明 + Node 指纹"的不一致本身是 bot 信号
（curl_cffi 文档同论）。
fallback（curl 缺失 / PI_WEB_TOOLS_NO_CURL=1）：undici + 钉死 curl UA +
Accept: */*——身份一致即止，不投 h1/密套调优（该路径近乎不走；严格反爬
有保险丝链兜底）。
```

### 请求行为

- **输出统一格式**（对齐 Markdown for Agents 布局）：frontmatter（
  `title`/`description`/`image`，仅输出有值的字段）→ 正文 → JSON-LD（
  有则末尾 fenced `json` 块）；协商直取（`Accept: text/markdown`）与
  本地转换输出同一格式。
- **内容判定：无门**。工具不做任何 content-type 准入判定——每道门都是
  替 LLM 做的"这个你不用看"决策，限制能力。规则只有两条：HTML/XHTML 默认
  走 markdown 提取（变换是服务，`raw` 随时可关）；其他一切响应原样返回
  （SVG/JSON/CSV/YAML 都是文本，真二进制有损解码成可辨认的噪声，
  `contentType` 字段说明真相）。剩余 error 仅协议层：网络失败、HTTP 状态、
  空响应、非 http(s)。数据层永不装饰内容（围栏会改写载荷且遇内嵌 ``` 破防），
  形状由 `contentType` 字段自描述。
- **溢出的两种消费模型**（映射 pi 自身 bash/read 的分流——源头是否持久）：
  网页 markdown =「读文章」，维持 pi 官方范式——封顶预览 + 截断标记
  （LLM 靠预览判断相关性）；其余一切（含 raw 源码）=「用数据」——LLM 是
  刻意来取这份文件的，预览只是全文消费时的重复成本，超预算即整份落盘、
  返回 `(content not inlined — 大小, MIME) + 路径`，交给 read 工具的
  offset/limit 翻页消费；二进制噪声由此不进 context。未超预算照旧内联
  （小文件不值得多一轮 read），预算沿用 50KB/2000 行不引入新阈值。
- **图片是第三种交付物**：`image/*`（SVG 除外——它是 XML 文本）不落文本
  通道，经 pi 的 `resizeImage` 归一化（自动缩放/降质进 ~4.5MB base64 预算）
  后返回 image block——TUI 按 cell 尺寸内联渲染（无字节限制），模型多模态
  消费。解码失败回落噪声路径（诚实可见），不做任何准入门。
- **下载缓冲上限（宿主物理保护，非政策）**：响应体流式读取、运行计数
  （不信任 Content-Length——chunked 响应没有），超 64MB 即弃流，返回
  `(content not buffered — 超限大小, MIME)`；64MB 远高于图片预算，
  一切可缩放图片均不受影响。Accept 不含 `image/avif`——本地图形解码器
  （Photon）解不了 AVIF（已实测），协商回 AVIF 只会把可显示的图降级成
  噪声；webp/jpeg/png 均可解。
- **raw 语义**：`raw: true` 时 HTML 也返回原始源码（无任何包装），请求头
  首选 `text/html`（不协商 markdown 正文）；不做 markdown 转换、不做 CSR
  渲染（要源码就不是要渲染结果）；站点 URL 重写（如 GitHub blob→raw）仍
  保留——那是 URL 语义改写，非格式变换。raw 路径不解析 title（一律空——
  raw = 纯原文，不做任何解析；默认路径才会提取 frontmatter title）。
- **CSR 页/反爬墙**（壳空 + JS 渲染 / HTTP 403/429/5xx）：**远程真实渲染保险丝**
  tinyfish fetch → bsk 真浏览器（LLM 拿真实内容不给占位）。本地 headless 已移除——
  同能力一份实现，也去掉「本机装了哪种 Chromium」的依赖。404/410 不发保险丝
  （页面确实不存在，渲染器无法复活）。渲染器自报输出类型（`RenderedContent`：
  tinyfish 请求 markdown → `text/markdown`；bsk innerText → `text/plain`），
  `contentType` 原样透传，不伪造（诚实规则）。
- **请求头 = 系统 curl 原生**（UA/Accept: */*/无 Accept-Language）；fallback
  用钉死 curl UA。动机史（openai/codex#18456：Cloudflare 按 UA 403 真实存在）
  留档——curl 是合法命令行身份，被拦的页面由保险丝链兜底（不丢能力，多一跳）。
- **错误规范化**：HTTP 状态/网络/超时 → `error` 字段（非抛异常）；
  超时与外部取消区分。
- **GitHub blob 直取文件**：`github.com/…/blob/<ref>/<path>` 重写为 raw 内容
  （LLM 要文件而非界面）；raw 不可用回退原 URL。
- **主路径零中转**：静态友好页始终直取（无 r.jina.ai 类常驻中转）；仅当直取
  失败（反爬/CSR）才走 tinyfish fetch——它本身就是转发渲染（诚实地位，非隐蔽）；
  认证/交互页归 bsk（用户真实会话）或 LLM 自行 bash curl。（2026-08 加入
  tinyfish fetch 前的既有承诺是「无任何第三方 fallback」，现已按保险丝需求修订。）

## 配置

API key 环境变量（有则升级、无则降级，全部可选）：

| 变量 | 作用 |
|---|---|
| `TINYFISH_API_KEY` | 启用主力通道（免费无限） |
| `EXA_API_KEY` | Exa 全参数 keyed 模式（无 key = MCP keyless 裸 query） |
| `TAVILY_API_KEY` | 启用 Tavily |
| `FIRECRAWL_API_KEY` | Firecrawl keyed 升档（与 pi-read-doc OCR 共享池，搜索尽量不碰） |
| `PI_WEB_TOOLS_NO_CURL=1` | 跳过系统 curl 子进程（hermetic 测试 / 无 curl 环境强制 fallback；存在性探测一次并缓存） |
| `PI_WEB_TOOLS_NO_BSK=1` | 禁用 bsk 真实浏览器通道（探测前短路——不弹窗、不起 daemon；默认测试套件强制） |
| `PI_WEB_TOOLS_TEST_BSK=1` | opt-in：运行真浏览器测试（bsk 会打开本机 Chromium）；需同时清掉 NO_BSK |
  （test/browser.test.ts 在 opt-in 时自行清除 NO_BSK） |

无 `PI_WEB_TOOLS_ENGINES`、无系统语言探测——可用性就是环境事实，变更即时生效（每请求检测）。

## 不在此范围

- **count / 分页参数**：结果量通道自然返回（各通道内定，5-10 条）。
- **engine / provider 参数**：路由与通道选择是实现细节，LLM 只表达意图（query/recency/domains/locale）。通道不可用时静默 failover，全灭才报错。
- **操作符参数化 / 自动检测**：操作符归 query 原样透传。
- **locale 自动推断**：语言检测是语义判断，工具不猜——query 语言 + locale 参数已覆盖。
- **模型 grounding**：曾有的"当前模型自答 + 引用"通道已移除（自问自答、成本不透明、snippet 非独立来源）；如需再评估。
- **locale 自动推断**：语言检测是语义判断，工具不猜——LLM 显式传。
- **独立 fetch 缓存 / storage**（pi-web 的 get_search_content 类机制）。
- **curator 浏览器交互 / cookie 借用 / GitHub clone / PDF 提取 / 视频理解**。
- **SSRF 防护**：fetch 是原语，与 bash curl 等价，安全责任在使用方（不为防误用加机制）。
- **地域/语言环境变量**：本地化自动行为 + `locale` 参数。
