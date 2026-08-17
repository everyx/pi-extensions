# pi-extensions 设计原则（项目级）

> 适用于 `packages/*` 下所有 pi 扩展。各包的具体设计记录在自己的 `SPEC.md` 中，通用原则只此一份。

## Pi Native

- **一致的调用方式**：工具参数 schema、命名风格与 pi 内置工具（`bash`、`read` 等）保持一致；`promptSnippet` / `promptGuidelines` 注入系统提示。
- **一致的输出质感**：渲染复用 pi 原生组件，排版、颜色、折叠展开遵循内置工具（bash 工具卡片）的惯例；widget 与内置 working 指示器同一视觉语言（accent spinner + muted 文本）。
- **一致的视觉家族**：工具卡、通知卡、伴生 widget 共用一套命名与状态标识，不出现品牌营销字样、无装饰 emoji（状态 icon 除外）。
- **依赖原生能力**：会话存储 / attach 走 pi 原生机制（`--session <path>`），不自造旁路系统。

## LLM + Token Friendly

- **Token Economy**：LLM 可见的 `content` 只含最小结构化信息；装饰性元素（title、用量、路径等）放 `details`——`details` 永不进入 LLM 上下文。
- **纯函数隔热层**：协议序列化/解析、模型解析等无副作用的逻辑做成纯函数，可独立单测。
- **不轮询**：后台结果由完成通知一次投递，不提供轮询/查询原语。

## 提供能力而非方案

提供原语，让用户组合。组合逻辑在调用者的 prompt 里，不在工具层。不封装工作流模板、不自动重试、不做结果后处理、不做预定义类型系统。

## 极简克制（Pi 极简风格的延续）

不为"防止误用"添加机制。如果某项机制的唯一理由是"用户/LLM 可能误用"，删掉它：

- 不设隐藏限制（无 token 上限、无默认超时）；限制只能由调用者显式要求（如可选的 `timeoutMs`）。
- 不投冗余通知：一次事件只投一次、如实汇报（如 spawn 失败已有 isError 工具结果，就不再加 follow-up 通知）。

## 统一视觉语法

所有扩展的卡片、通知、widget 共用一个渲染语法，对齐 pi 内置工具：

- **icon 前置**：所有状态标记（spinner / ✓ / ✗ / ■）在行首——与 pi 内置 Loader 一致。
- **全阶段 Box 壳**：工具任何阶段不出无壳 spinner，pending → success/error 底色全程覆盖。
- **`·` 只做 meta 分隔**：不分割动词短语；时间归 header meta、footer 仅路径类摘要。
- **内容行从卡片左边缘起**：body/footer 不对齐 header 文字，空行即分隔（pi bash 卡惯例）。
- **统一折叠**：卡内容超出预览预算时折叠为尾部预览 + 展开提示（对齐 bash 工具卡的 preview 行数与 hint 格式）；展开全显。
- **LLM context 截断保护**：进 LLM 的 content 经截断（对齐 pi bash 工具的默认截断预算）；UI 渲染源不截断——用户展开看全部，只有 LLM 看到截断版。
- **占位/兜底（仅渲染层）**：卡内容缺失时 dim 色 + 括号占位（对齐 pi bash 卡的 `(no output)`）。

## TUI 即时反馈

- TUI 在执行的关键节点即时反馈有意义的信息给用户——通道/通道切换、活动流、进度、完成/失败都在发生时就可见，而不是等最终结果一起出现。
- 长时间静默（无 spinner、无状态词、无数据变化）是缺陷。
- preview 必须 1:1 反应真实行为（不模拟 UI 不存在的反馈，也不省略真实存在的反馈）。
- 进行中的统一状态词用 `working…`（对齐 pi 内置指示器措辞）；有更具体的信息（通道、动作）时优先展示具体信息。

## 开发约束

- 不引入第三方 UI 库。
- 参数枚举用 `StringEnum`（Gemini 兼容）。
- 空行：用 `Text("\n" + content)`，别用 `Text("")`。
- 渲染函数内禁止同步调用 `context.invalidate()`。