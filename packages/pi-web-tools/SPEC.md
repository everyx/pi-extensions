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
- **通道回声**：实际通道只进 `details`（UI 卡片可见），LLM 零感知。
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

四条 HTTP 通道按**免费额度从大到小**排成保险丝链。可用性 = key 是否解析得到（环境变量优先，其次 `<agent 目录>/web-tools.json`），零配置、零系统语言探测：

| 通道 | 免费额度 | key 缺省时 |
|---|---|---|
| **TinyFish** | 30 req/min（需 key） | 不可用 —— **2026-11 起服务端强制 key**（search 与 fetch 都是，无 key 返回 401 `MISSING_API_KEY`） |
| **Exa** | MCP keyless（3 qps / 150 calls/day，仅裸 query） | keyless 运行 |
| **Tavily** | 1,000 credits/月 | 不可用 |
| **Firecrawl** | keyless（per-IP 每日上限，Google 后端） | keyless 运行 |

**免费层优先、key 升级**是全链统一模式：exa 无 key 走 MCP（`exaSupports` 把带过滤器的请求让给后续通道）、firecrawl keyless 429 才动 `FIRECRAWL_API_KEY`（该池与 pi-read-doc 的 OCR 共享，搜索尽量不碰）。

**fallback 链**：tinyfish → exa → tavily → firecrawl。链上错误静默降级到下一通道；全灭才报错（failures 进 details）。

**无 key 时仍可用**：exa（MCP keyless）+ firecrawl（keyless）。真实浏览器通道曾作为链尾的无 key 保险丝，2026-10-31 整条移除——见「外部依赖」一节。

## 操作符（query 原样透传）

LLM 对搜索操作符有先验知识（`site:` / `filetype:` / `-` / `OR` / 引号）。因此：

- **不参数化操作符**（`filetype?: "pdf"` 是封装——把 LLM 已会的几十个操作符锁死成枚举）。
- **不自动检测、不改写**：query 原样透传给通道。Google 后端通道（firecrawl）原生兑现操作符；语义通道（exa）把操作符当文本——这是通道间的真实差异，由 failover 与结构化参数（allowed/blocked_domains 即 `site:` 的结构化形态）兜住，不对 LLM 承诺。
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

- **俄语（yandex）已移除**：单一市场价值低、维护成本高；ru 语 query 走 google。

## 外部依赖

**只有 HTTP API，没有本机二进制依赖**（2026-10-31 移除 BrowserSkill/bsk）。真实浏览器通道曾用本地 Chromium 渲染反爬墙与 CSR 页面，代价是：需要用户单独安装一个 CLI、需要一台开着的浏览器、并让本扩展的可靠性绑在第三方 CLI 的参数契约上——它一改版，整条兜底就失效。搜索与抓取因此都退回纯 HTTP 通道：

| 场景 | 现在 |
|---|---|
| `web_fetch` 反爬/CSR 页 | firecrawl scrape → tinyfish fetch（服务端渲染，无本机依赖） |
| 搜索额度尽 | exa / firecrawl 的 keyless 模式 |

需要登录或交互的页面不在本扩展范围内——交给 LLM 自己 bash curl。

## 错误处理与诊断

### 错误分层

- **LLM**：收到简洁错误（如 "filetype 需要真实浏览器通道"），**不含安装/配置指引**（细节不进 LLM 上下文）。
- **用户（TUI）**：看到完整诊断（原因 + 建议），展开可见全部细节（对齐统一视觉语法的折叠预览）。配置指引（如 `Set FIRECRAWL_API_KEY…`）经 `summarizeFailures` 拼进 `details.error`——那是卡片唯一渲染的文字通道；失败记录里的 `hint` 字段本身无渲染器读，单独放着等于没写。
- **无本机安装步骤**：本扩展只依赖 HTTP API，没有需要用户编译或安装的二进制。

### 错误计划结构

错误不是单行报错，而是结构化诊断块（对齐根 SPEC 统一视觉语法）：

- `expanded`：完整诊断（展开时 Ctrl+O 可见）
- `collapsed`：折叠预览行
- `expandHint`："... (N more lines, ctrl+o to expand)" 提示

内容包含：原因、实际通道、失败阶段（如 "HTTP 429 / empty extraction"）。

## 能力与路由

```ts
candidatesFor(params, channels): SearchChannel[]          // 链序 ∩ 可用（key/CLI）∩ 能力（supports）
searchFuse(params, channels, { signal, onAttempt }): Outcome   // walk：failover · 错误累积 · 末错入 LLM
```

- 每通道一个 `available()`（key 非空）+ `supports(params)`（能力门控——keyless Exa 不能兑现过滤器/.locale 时**跳过该通道**而非静默丢参数：SPEC 能力缺失不静默）。
- 路由按链序 failover，错误累积进 details.failures；全灭才对 LLM 报错。
- 注册表在 search/channels.ts（每通道一个自描述对象：available/supports/search/echo，纯组装）；walk 逻辑在 search/fuse.ts（fake 通道可单测）；HTTP 细节在各适配器。加通道 = 一个适配器文件 + 注册表一条 + `ChannelId` union 一个成员（类型系统强制）。

## web_fetch 行为规格

### 传输层（2026-11 四改：撤销系统 curl，回到进程内 undici）

```
主传输：Node fetch（undici），进程内，流式入 64MB cap。
代理：EnvHttpProxyAgent —— 读 HTTP_PROXY / HTTPS_PROXY / NO_PROXY。
```

**为什么撤销 curl**（2026-11-03 实测）：同一批 URL、同一组请求头，curl 与 undici 的成败**完全一致** —— 被墙的三个站对两者都是 403，通畅的都是 200。curl 没带来成功率，却要求我们维护两套实现（curl 子进程 + undici fallback）、每次抓取 spawn 一个进程、建临时目录写响应头、把用户 URL 拼进 argv。

**curl 原本免费给我们的东西，现在要显式补上**：代理环境变量（Node 的 fetch 默认不认，gemini-cli 同样用 `EnvHttpProxyAgent` 补）。`--compressed` 由 undici 自动协商与解压。

**为什么不装 Chrome / 不上 TLS 指纹**：2026-11 的实测（26 URL × 4 种客户端配置）里，curl_cffi 伪装 Chrome 指纹在 8 个硬墙站上**全数 403**，只在「仅校验 TLS」的站上赢过一次；而 curl-impersonate 上游 2024-07 停更、维护分支每几周换 profile。这是持续付费的军备竞赛，换不到我们需要的成功率。

### 请求头（2026-11 加入）

```
User-Agent: Mozilla/5.0 (compatible; pi-web-tools/<version>; +https://github.com/everyx/pi-extensions)
Accept:     text/markdown, text/html;q=0.9, */*;q=0.5   （raw: text/html 优先）
Accept-Language: en-US,en;q=0.9
```

- **UA 用 `compatible` 形式**：这是「浏览器形态但如实自报」的通行写法（gemini-cli / opencode / cline 同款；dsh 的注释叫它 "an explicit product agent, never a browser disguise"）。版本号从 `package.json` 读，不写死——UA 里的假版本号没有意义。
- **`Accept` 把 markdown 排前面**：Cloudflare 的 Markdown for Agents 在边缘就转好（**实测同一页 16 KB vs 176 KB**），任何静态文档站也能直接给。**它不改变反爬结果**——实测未启用该特性的 zone 照样回挑战页——所以这是省 token，不是过墙。
- **`Accept-Language` 是 curl 从不发、而我们补上的**：它是内容协商，不是伪装。实测里它正是那唯一一次「403 → 200」的决定性头部。

### 失败分类与重试（2026-11 加入）

失败不是一类，重试之前先分类：

| 类型 | 例子 | 处理 |
|---|---|---|
| **JS 挑战** | `cf-mitigated: challenge`、`x-amzn-waf-action: challenge`、正文含 "Just a moment"/"Checking your browser" | **不重试** —— 实测跨多次、跨客户端配置完全一致；重试只烧时间与 IP 信誉。直接交给渲染保险丝，并告诉模型「被挑战挡住」而不是「页面坏了」 |
| **软封锁** | 状态 **200** + 正文 "Blocked by network security" / "Access denied" / "unusual traffic" | 同上，按墙处理 |
| **瞬时故障** | 429 / 502 / 503 / 504、连接重置、DNS 抖动 | 有界退避重试（最多 3 次，300ms 起 ×3 + ±20% 抖动），总时长受同一个 deadline 约束 |
| **确定的拒绝** | 404 / 401 / 402 / 429 之外的 4xx | 不重试 |

**渲染器同样会被墙**：Firecrawl 会把 "Blocked by network security" 当作干净的 markdown、配 200 交回来。所以同一套墙特征检测也作用在渲染结果上——否则一个礼貌的拒绝就会顶着成功状态抵达模型。

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
- **CSR 页/反爬墙**（壳空 + JS 渲染 / HTTP 403/5xx）：**远程渲染保险丝**
  `firecrawl scrape`（无 key 可用）→ `tinyfish fetch`（需 key）。本地 headless 与
  浏览器 CLI 都已移除——渲染一律是 HTTP API。渲染器自报输出类型（都是 markdown），
  `contentType` 原样透传，不伪造（诚实规则）；`details.renderer` 记下实际是谁给的。
  - **进链前先判能不能救**（`renderMayHelp`）：404/410（页面不存在）、401/402/407
    （要钱要授权）、429（额度）、451（法务）不渲染 —— 渲染器改变不了这些答案，
    进去只是花时间和别人的带宽。网络失败（无状态码）、403、5xx 才进。
  - **共享 45s 预算**：所有渲染器共用一个 deadline，每个拿剩余时间（单次上限 30s），
    剩不足 5s 就不再起下一个。没有这一条，三个慢供应商串起来能把一次失败变成几分钟。
  - **顺序 = 可用性**：无 key 的 firecrawl 在前，需 key 的 tinyfish 在后（后者
    `available()` 为假就直接跳过，不浪费一次 401 往返）。
  - **匿名访问 Firecrawl REST 是事实，不是承诺**（2026-11-03 复核）：官方文档只
    写了 `Authorization: Bearer`，没声明 keyless 层。实测：无 Authorization → 200；
    无效 key → 401 `Invalid token` —— 说明匿名与鉴权是两条真实不同的路径，而不是
    「没带 key 就当无鉴权」。同一套 keyless 早就在搜索通道里跑着（`/v2/search`）。
    但**接口没承诺**，所以：任何非 2xx（含 401/403）都只让这一跳失败、继续下一个
    渲染器，并把原因记进 `details.rendererFailures`；万一匿名被关，卡上会写
    `firecrawl: HTTP 401`，而不是又一次静默变成「没有内容」。
  - **排队也算预算，而且排队能被取消**：限流器是串行队列，光在「拿到槽位后」看表
    只保证不发过期请求，不保证等待本身有上界。所以 `runBefore(fn, {deadline, signal})`
    让**队列中的**任务在超时或调用取消时立刻以 `null` 退出队列 —— 45s 是整条渲染链的
    上界，不是「每次 HTTP 请求」的上界。
    边界的精确说法：它约束的是**调用方等多久**，不是**工作何时停**。一旦 fn 已经开始
    执行，到点只会让调用方拿到 `null`（结果丢弃），fn 照常跑完 —— 需要真正中止的工作
    必须自带 deadline 或 signal，渲染器正是这么做的（把剩余时间交给 `fetchWithTimeout`）。
- **浏览器保险丝已从 web_fetch 移除**（2026-10-31）：它依赖 BrowserSkill 的 CLI
  契约，上游一改版整条 fetch 兜底就失效。
- **请求头 = 系统 curl 原生**（UA/Accept: */*/无 Accept-Language）；fallback
  用钉死 curl UA。动机史（openai/codex#18456：Cloudflare 按 UA 403 真实存在）
  留档——curl 是合法命令行身份，被拦的页面由保险丝链兜底（不丢能力，多一跳）。
- **错误规范化**：HTTP 状态/网络/超时 → `error` 字段（非抛异常）；
  超时与外部取消区分。
- **GitHub blob 直取文件**：`github.com/…/blob/<ref>/<path>` 重写为 raw 内容
  （LLM 要文件而非界面）；raw 不可用回退原 URL。
- **主路径零中转**：静态友好页始终直取（无 r.jina.ai 类常驻中转）；仅当直取
  失败（反爬/CSR）才走渲染保险丝——它本身就是转发渲染（诚实地位，非隐蔽）；
  需要登录/交互的页面归 LLM 自行 bash curl。（2026-08 加入 tinyfish fetch 前的
  既有承诺是「无任何第三方 fallback」，现已按保险丝需求修订；2026-10 撤掉
  浏览器保险丝，2026-11 起渲染链为 firecrawl → tinyfish。）
- **隐私：兜底默认会把目标 URL 发给渲染供应商**（2026-11-03 定为显式选择 A）。
  主路径（curl 直取）零中转，但一旦进保险丝，URL 就离开本机——这比搜索发 query
  更敏感，所以必须在 README 明说，而不是只写「主路径零中转」就完事。

## 配置

**key 的两个来源**（2026-11-03 加入文件源）：

1. 环境变量 `TINYFISH_API_KEY` / `EXA_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY`
2. `<agent 目录>/web-tools.json`（`getAgentDir()`，默认 `~/.pi/agent/web-tools.json`），扁平 `{ "<provider>": "<key>" }`

环境变量优先：它是更明确的、按次生效的选择，也是 CI 里唯一存在的来源。文件**按进程读一次并缓存**，从不写入；缺失/读不出/JSON 非法/类型不对，一律等于「没配」——与变量未设置完全等价，不产生错误。未知 provider 项被忽略而不是报错（文件比 provider 活得久时不该拖垮剩下的）。

没有项目级文件：key 是用户级的，`.pi/web-tools.json` 只会招来提交进仓库的风险。pi 本身没有扩展密钥存储（`auth.json` 属于 LLM provider），「env 优先 + 自己的 JSON」是生态里同类扩展收敛的做法，我们沿用同一形状。


API key 环境变量（有则升级、无则降级，全部可选）：

| 变量 | 作用 |
|---|---|
| `TINYFISH_API_KEY` | 启用主力通道（免费无限） |
| `EXA_API_KEY` | Exa 全参数 keyed 模式（无 key = MCP keyless 裸 query） |
| `TAVILY_API_KEY` | 启用 Tavily |
| `FIRECRAWL_API_KEY` | Firecrawl keyed 升档（与 pi-read-doc OCR 共享池，搜索尽量不碰） |
（没有本机二进制相关配置：真实浏览器通道已移除。）

无 `PI_WEB_TOOLS_ENGINES`、无系统语言探测——可用性跟着 key 走：环境变量每请求实时读取，文件按路径读一次并缓存（`resetKeysCache()` 可清）。

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
