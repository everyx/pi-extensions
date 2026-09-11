# pi-read-doc — design intent

Enhanced `read` for office documents: `read_doc <path>` returns clean Markdown.

## 工具面

- One tool: `read_doc` (`{ path }`). Not in `defaultActiveToolNames`; enable via `settings.json: defaultTools` or `pi --tools`.
- Header-only folding (read-like): collapsed shows `read_doc <path>`, expand reveals full Markdown.
- Non-office files fall back to raw utf-8 text — binary files will garble; prefer `read`.

## 转换链路：解析一次，然后按配置试 OCR 引擎（2026-09）

**解析器**（`WalkDeps.parse`，index.ts 注入的 anydoc 动态 import）先把**整份**文档转成 markdown；它要么成功，要么以 `needsOcr` 拒绝（一页扫描就拒整份，实测）。被拒之后，**walk**（`convert.ts` 的 `convertDocument`）按配置顺序逐个问引擎，第一个能服务的胜出。

三个概念，别混：

| 概念 | 是什么 | 今天谁 |
| --- | --- | --- |
| **引擎**（`Engine`，契约声明在 `convert.ts`） | 把一份"需要 OCR 的文档"变成页块；**配置里的名字就是它** | `firecrawl`、`rapidocr`（`ocr/engines/*.ts`） |
| **页级识别器**（`PageOcr`，定义在 `ocr/engines/rapidocr/page.ts`） | 图片进、逐页文字出。**不是并列抽象**，是 rapidocr 引擎内部的实现细节（它唯一的消费者就在隔壁） | 只有 rapidocr 需要它 |
| **解析器** | 本地把文档转成 markdown，或判它 needsOcr | anydoc |

- **配置 `PI_READ_DOC_OCR_ENGINE`**：逗号分隔的**有序**列表（顺序即优先级），默认 **`rapidocr,firecrawl`**（本地优先、云端兜底：装了本地引擎的机器默认不外传）；取值 = 引擎名 ∪ `off`。**非法值 fail-closed**（拒绝并列出合法值），空值同样拒绝——"我以为锁上了"不能变成"其实在上传"。解析在**每次调用**内完成，绝不在模块加载期（顶层抛错会打断整个扩展加载）。
- **引擎实例由 `ocr/engines/registry.ts` 管**：id → 实例，懒建、进程内复用（解释器探测、poppler 工具检查、将来的模型句柄都靠它跨读取存活）；注册表 =（工厂表 + 实例表）成对存在，测试注入自己的工厂表就能观察"到底构造了谁"，且不碰生产实例。**生命周期**：首次被配置选中时构造（同步，无交错点）；存活到进程结束；今天没有 `dispose`（两个引擎都不持有外部资源），将来哪个需要释放就加可选 `dispose()` 挂 `session_shutdown`。
- **`rapidocr` 时 `firecrawl` 引擎根本不会被构造**——全项目**唯一**的上传调用点（`toMarkdown(path, { ocr: "hosted" })`）在 `ocr/engines/firecrawl/engine.ts` 里。这就是 issue #27 那条保证的结构形态。
- **全落空** → 原 needsOcr 错误抛出；execute 用 `conversionFailure(msg, info, config)` 组装结果：LLM 只拿引擎的简洁错误，引擎自己的原因与配置说明拼进 `details.error`——卡片唯一渲染的文字通道（`details.hint` 无人读，等于写给空气，根 AGENTS.md 错误分层）。**配置指引永不进模型上下文**（模型改不了环境变量）：合法取值、`=off` 说明、引擎名只出现于 `details` / hint。唯一进模型侧的是那句失败原因本身（`OCR unavailable: PI_READ_DOC_OCR_ENGINE is invalid`）——不点出是配置问题，模型就无法向用户转述。
- **中止（Esc）**：walk 在进入每个引擎前查 `signal.aborted`，引擎报 `cancelled` 就立即停 —— 取消之后**绝不**再发起新的尝试（包括整份上传）。边界：`firecrawl` 的在途上传不可取消（anydoc 的调用没有 signal），它会跑完并交付结果；取消保证的是**不再发起新工作**，而不是丢弃已经付过费的结果。`rapidocr` 侧全链传导（渲染/OCR/子进程都能被 Esc 打断）。

## 本地恢复（needsOcr 之后；2026-09）

anydoc **整份文档一把梭**：只要一页需要 OCR，整个文档被拒，文字页内容一起丢（实测）。所以恢复的第一件事不是 OCR，而是**把文字页抢回来**：

```
① anydoc(整份) ──成功──▶ markdown            ← 快路径，绝大多数文档到此为止
② 拆出「anydoc 未标记的页」→ anydoc(子集) → markdown   ← pdfseparate/pdfunite，100 页 0.09s
③ 标记页先试 pdftotext（**一次调用覆盖所有页**，`\f` 分页）：有文字 → 用文字层（anydoc 会误判）
④ 真无文字的页 → pdftoppm 渲染 → OCR 引擎
⑤ 都不行 → note（"no text found in the page image" / 超预算 / 渲染或转换失败），绝不静默留空
```

- **标记名单是提示不是真相**：实测 anydoc 会把「文字层完好」的页也标进去（gs 造的纯文字 PDF、带配图的文字页都复现过），所以 ③ 是先付便宜的钱。误判页会并回文字段（`pdf/plan.ts` 规则，表驱动测试）。
- **两类「图片」按页区分**：整页图（扫描页）走 OCR 路径，它的图是**载体**；文字页里的配图属于内容，本次不抽取（缺口）。页图只作 `image` **字段**返回，**绝不写成 markdown 图片语法**——那会让模型以为本页有一张配图。
- **预算是时间，不是页数**（`PI_READ_DOC_OCR_TIMEOUT_MS`，默认 120s）：单页 OCR 实测 ~2–3s，但**一页要多久取决于它有多少文字**，所以页数表达不了"这次最多花多久"。deadline 覆盖整次恢复（探测/拆分/渲染/OCR），每一步边界复查；OCR 子进程的超时 = **剩余预算**，到点即杀。
- **OCR 分批**（每批 5 页：渲染 → 识别 → 下一批）：一次引擎调用最多押 5 页，超时或崩溃只损失这一批（其余照常交付），模型加载（~0.8s）也摊薄到每批一次。磁盘不由分批封顶——**没有单批清理**，页图落满 scratch 直到整次调用结束才删；封顶它的是时间预算（一页几秒，120s 也就几十页）。
- **中止（Esc）全链传导**：`execute` 的 signal → `convertDocument` → `recoverPdf` → `recognize` → `spawn`，按 Esc 真的杀掉 python 进程；中止是 **cancelled 失败**，不拿半截结果冒充读完了。
- **进度可见**（`onProgress` → 工具的 `onUpdate`，落在卡片真会渲染的 `details.data`）：开始时报「N of M pages」，之后每批报当前页。一页扫描要几秒，一张全程只有 `working…` 的卡片看起来就是卡死了。
- `firecrawl` 的整份 blob 切不开，但**哪几页**读过 OCR 我们知道：这句话只进**卡片的 hint**（`pages 3, 7 were read by firecrawl OCR — the document was uploaded`，措辞归 `ocr/engines/firecrawl/engine.ts`），**不进模型载荷**——文本从哪来不是模型能据此行动的信息，而「可能读错」是模型自己的先验（根 AGENTS.md LLM 文案：自省的不写）。
- 预算耗尽 / 未渲染 / 整批读不出 → 都进 note 块（按原因合并、页号列全），**不静默丢**；预算耗尽是**部分结果不是错误**。
- **没有内容阈值**：引擎读到的都进 `text`（实测：示意图出 1 个垃圾字符 `_`@0.82，噪点图 0 行）；不可信由每块的 `note` 标注，而不是删掉内容（见下节字段规则）。

### 输出形态（一条规则）

| 输入 | content |
|---|---|
| anydoc 直接成功（纯文字 / 图文混排） | **markdown 原样**（与旧行为完全一致，零开销） |
| 触发过 OCR（`firecrawl` 或 `rapidocr`） | **JSON 块数组**：`[{pages, text, image?, note?}]`，按页序 |

JSON 只用在没有 markdown 需要保护的路径上（全扫描档正文本就是 OCR 文本），转义损失≈0。序列化**之前**按块计预算（截断的 JSON 不可解析）。

**块的四个字段，各司其职**：

- `pages`：页归属，**紧凑字符串**（`"3"` / `"1-2"` / `"3, 7"` / `"21-137"`）——模型引用"第 5 页写了…"用；一长串数字是白付 token
- `text`：**一律装引擎真实识别到的内容**——没有任何**长度**阈值可以把"读到了 `_`"改写成"没有文字"（那是对事实的篡改；曾经的 `MIN_PAGE_CHARS` 因此被删）。**置信度下限**（`DEFAULT_TEXT_SCORE = 0.5`，我们对引擎输出的过滤）另说：低于它的行不进 `text`——这是**显式**的过滤，不是隐形的长度阈值；页面因此被判为空时，note 说的是 `only low-confidence text in the page image`（引擎如实报告被丢的行数），**不谎称图里没有文字**
- `image`：来源页图路径，**只出现在 `rapidocr` 的块**上（`firecrawl` 返回整份 blob，没有页图；图是页面的载体，不是文档里的插图——插图的缺口见上节）
- `note`：**只在「读者自己看不出来」时出现**（2026-09 收紧）：空页 `no text found in the page image`、只有低置信度文字 `only low-confidence text in the page image (N lines)`、超预算/中止/渲染失败/没渲染 `not read: …`、回复放不下 `read but omitted: output budget`。**有文字就没有 note**——「这段是 OCR 读的」已由 `image` 字段自证，「可能读错」是模型自己的先验，都不是我们该替它说的话（根 AGENTS.md「LLM 文案五约」：自省的不写）

note 只出现在真需要的块上（缺页原因按块重复，模型引用第 7 页时不必回头看别的块）；因此**没有文档级 legend，也不需要 `source` 枚举字段**（2026-09 决策：`source`+`note` 归一为 `note`，自然语言对模型更友好；随后又收紧为「只在读者看不出来时出现」）。

### 渲染：目标 DPI + 像素上限（两档）

OCR 真正需要的是**文字在像素上的高度 = 物理尺寸 × DPI**，所以"把长边归一化到 N 像素"是错的：它把名片渲染成 440dpi（凭空放大），把 A0 压到 47dpi（文字 6px）。实测畸形页框（1700×2200 *pt*，扫描件常见的"像素当点"）：固定 `-r 200` → 28.9MP / 1.2s；`-scale-to 2200` → 3.7MP / 0.2s（前者浪费且更慢）。

规则：`dpi = min(目标DPI, 上限px × 72 / 页面长边pt)`；页框由 `pdfinfo -f 1 -l N` 一次取回。

| 用途 | 目标 | 上限 | letter 实得 | 为什么 |
| --- | --- | --- | --- | --- |
| OCR 引擎输入 | 200 | 2200px | 1700×2200（正好 200dpi） | 检测模型要 ~30px 的文字高度 |
| LLM 观察副本 | 150 | 1500px | 1150×1500（136dpi，≈2300 token） | 模型自身也会把图压到 ~2000px；给更大的图 = 为会被丢掉的像素付 token（2200px 约 4100 token） |

OCR 输入落 **scratch**（整个调用结束后由 rapidocr 引擎删除；**分批限制的是渲染页数，不是单批清理**——所以磁盘占用由时间预算封顶，而不是"只留一批"），观察副本落 **artifacts**（按路径命名空间：`os.tmpdir()/pi-read-doc-<sha1(path) 前 8 位>/`，同一文件反复读落在同一个目录里，但**页图不跨次复用**：每次读取用自己的 tag 重新渲染（同一路径二次读取必须不认错文件），所以目录里会留下历次读取的页图，直到 tmp 自己清理）。**不在 `session_shutdown` 删除**：transcript 里存着这些页图路径，而 new/resume/fork 之后那份 transcript 仍然可以被打开、被继续——删了就等于承诺「模型可以回看」却不给看（实测 ENOENT）。所以它们留在 tmp（每次读取几十到几百 KB，按路径分目录、不去重），交给操作系统的 tmp 清理策略。

### 引擎层与页级层（2026-09 重设计）

**没有 port 文件**：`Engine` / `ServeContext` / `ServeResult` / `EngineId` / `joinHints` 由 walk（`convert.ts`）声明，引擎实现它——消费者定义接口，低层去满足，`convert.ts` 不 import 任何引擎，因此无环。唯一的中立叶子是 `ocr/recovered-block.ts`（载荷类型：`blocks.ts` 与引擎都要，且不属于任何一边）。

- **加一个引擎** = 一个同名目录 `ocr/engines/<名字>/`（`engine.ts` 导出工厂）+ `convert.ts` 的 `ENGINE_IDS` 加一项 + `registry.ts` 的工厂表加一行（`Record<EngineId, EngineFactory>`：少一个 id 就编译不过）。
- **每个引擎自装配**：`createFirecrawlEngine({ upload?, gate?, limit? })` / `createRapidocrEngine({ pdf?, pageOcr?, convertSubset? })`，生产默认在各自模块内（`firecrawl` 的文件版 gate、`rapidocr` 的 poppler 工具与模块级页级单例），测试通过可选参数注入假体——`index.ts` 因此不知道任何引擎的内部。
- **页级层不对外**：`PageOcr`（图片进、逐页文字出）定义在 `ocr/engines/rapidocr/page.ts`，紧贴它唯一的实现与注入点。将来真要第二个页级实现，那也是一个**引擎**（配置面认得的接缝），或者到时再从 rapidocr 引擎里抽公共部分。
- **所有版本脆弱性都关在页级文件里**：3.x（`txts`/`scores`）与 2.x 元组探形、解释器枚举、置信度阈值、超时抢救（逐页 JSONL，杀进程仍保留已完成的页）、`installHint()`。
- **已知边界**：PDF 原生引擎（如 ocrmypdf、`firecrawl/pdf-inspector`）要么作为整份文档的引擎（像 `firecrawl` 那样自成一档），要么需要一个 `inputKind` 能力位——那是小改，今天不做。

## 配图（图文混排里的插图）：已知缺口，等上游（2026-09）

**现状**：图文混排文档走快路径返回 markdown，**其中的插图被丢弃**。这不是遗漏，是刻意不做。

**为什么不自建**：

- anydoc 的 `toMarkdown` **把图片整个丢掉且不留占位**（实测：带图 docx → 只有文字，连 `![]()` 都没有）；`toDocument().assets` 有字节，位置只在块树里（`Inline{kind:"image", source:{kind:"asset", assetId}}`），而且 **PDF 根本不支持 `toDocument`**。
- 要做"位置精确的内联引用"（pandoc `--extract-media` 那种），就得**基于 `toDocument` 自己渲染 markdown**（跨行表格、列表样式、内联样式…）并永久维护它。
- 只把图片列成清单（页码/顺序 + 路径）是**半成品**：有图无位，人和模型都无法把它放回上下文——**不如不做**（2026-09 决策）。

**上游在做的正是这件事**，所以等，而不是重造：

| 上游 | 内容 | 状态（2026-09-11 查） |
| --- | --- | --- |
| [#63](https://github.com/firecrawl/anydoc/issues/63) | 要求在**图片出现的位置**发出 `![alt](asset:N)`；P2 enhancement | OPEN |
| [PR #70](https://github.com/firecrawl/anydoc/pull/70) | #63 的实现（OOXML 侧 asset:N hrefs），快照测试已按 review 修完 | OPEN，MERGEABLE，等维护者合并 |
| [PR #83](https://github.com/firecrawl/anydoc/pull/83) | PDF 侧"带位置的图片文件" | DRAFT + CONFLICTING，08-12 后搁置 |

**上游落地后怎么接**（预计十几行，不是重构）：把 markdown 里的 `asset:N` 引用**物化到制品目录**（`os.tmpdir()/pi-read-doc-<hash>/`）并**重写 href 为真实路径**——与页图机制同形。语义要守住：**插图的引用就该是图片语法**（它确实是文档里的一张图），而扫描页图仍走 `image` 字段（图是页面的载体，不是文档内容）。

**重新评估的触发点**：#70 长期不合并（约 1–2 个月），或需要 PDF 配图而 #83 仍不动。

## 与上游的重叠（上游落地后可能变薄的部分）

本地恢复有三块与上游在做的功能重叠。不是错，但要知道它可能被上游吃掉：

| 我们 | 上游 | 上游落地后 |
| --- | --- | --- |
| `pdf/poppler.ts` 的 `separate`/`unite`（抢回文字页） | [#144](https://github.com/firecrawl/anydoc/issues/144) + [PR #153](https://github.com/firecrawl/anydoc/pull/153) / [PR #166](https://github.com/firecrawl/anydoc/pull/166) | 可删（anydoc 自己返回可读页） |
| `pdftotext` 整份探测（防 anydoc 误判；一次调用而非逐页） | [#62](https://github.com/firecrawl/anydoc/issues/62) + [PR #91](https://github.com/firecrawl/anydoc/pull/91)（逐页 API） | 视情况可删 |
| `ocr/` 本地 OCR | [PR #61](https://github.com/firecrawl/anydoc/pull/61) / [#146](https://github.com/firecrawl/anydoc/issues/146) / [#157](https://github.com/firecrawl/anydoc/issues/157) | 视情况可删 |

**与根 SPEC「不设隐藏限制」的边界**：本地恢复的预算是**防挂死护栏**（外部进程可能挂死），不是对 agent 能力设的隐藏上限——默认 120s、可用 `PI_READ_DOC_OCR_TIMEOUT_MS` 调，且不限制读取多少内容；根规则针对的是 token 上限、必填超时那类。

**不预判、不提前删**：这些 PR 全是 open/draft，而我们的路径今天可用且已测。引擎层（`ocr/engines/`）与页面路由（`pdf/plan.ts`）在两种未来下都成立——上游真落地时，先删的是 poppler 适配层。

## LLM 截断（根 SPEC：LLM context 截断保护）

- 进 LLM 的 content 头部截断——直接用 pi 官方 `truncateHead`（2000 行 / 50KB，**UTF-8 字节**计数，与 pi bash/read 同一实现，预算真对齐）+ 截断标记（真实输出/总量行数与字节数）。
- 卡展开走 `fullContent` 全量（仅截断时设置）——UI 渲染源不截断，只有 LLM 看到截断版。

## firecrawl 额度：反应而非估算（2026-09）

**不再本地计数**。旧实现按"扫描页数"记账，但请求上传的是**整份文档**（Parse 没有页选择）——400 页文档只记 1 页，账本是虚构的。现在改为**按服务返回的真实状况停摆**：

| 信号（Firecrawl 官方语义） | 停摆到 |
| --- | --- |
| **402** out of credits（计划额度用尽） | **下月初**（额度不会在月内回来） |
| **429 keyless**（免费层，按 IP **按天**的两个上限） | **次日 0 点** |
| **429 keyed**（每分钟频率限制，瞬时） | 不停摆（稍后重试即可） |
| **401** key 被拒 | 不停摆，但提示用户——配置问题不能因为本地恢复成功就消失 |

- **识别只能靠文案**：anydoc 的 `describe()` 已经区分了这三类（它知道状态码），但**结构化状态码没有暴露**（`code` 一律是 `hosted`，HTTP 错误路径 `cause` 为空）。匹配不上的退化是安全的：**只损失一个优化，不会做错事**（照常交给列表里的下一个引擎）。
- 持久化 `~/.pi/read-doc.json`（`homedir() + CONFIG_DIR_NAME`；**不跟随** PI_CODING_AGENT_DIR——用户级状态不该随 agent dir 漂移）：`{ firecrawl: { skipUntil: ISO, reason } }`（**读旧键 `hosted`**：忽略它会让已停摆的用户多上传一次；写只写新键）。停摆期内**不发起请求、不上传**，交给列表里的下一个引擎；原因进 `details`（UI），用户手删文件即可立刻恢复。
- `rate-limit.ts`（2 qps）保留：那是"别把 API 打爆"，与额度是两件事。它现在是 `firecrawl` 引擎的默认限流器。
