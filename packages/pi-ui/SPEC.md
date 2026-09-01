# pi-ui SPEC

pi 扩展的共享原语库，两族：**视图**（数据驱动卡片——工具声明「数据 → 卡片」的映射，渲染/折叠/配色/状态推导归 pi-ui）与**非视图原语**（宽度安全 `width.ts`、LLM context 保护 `context.ts`——同样单点收敛）。工具永远不碰渲染与宽度计算。

## 职责边界（宪法）

**UI 层只承诺两件事：对齐 + 不崩；内容与形态归调用方。**

- **对齐**：结构化前缀（box / padding-left）由 UI 层定，内容在固定缩进下对齐。
- **不崩**：pi 对任何超宽行崩溃（`visibleWidth` 是它的判据），且换行符零宽塌缩会撒谎——因此拍平、截断、宽度预算全部单点收敛在 UI 层的出口（`width.ts`），调用方永不做宽度计算。
- **形态（单行 / 可折行）由调用方表达**：自绘行走 `structRow`（一物理行，必适配）；可折行内容放 `Text` 组件（自动 wrap，bash 式完整显示）。
- **数据层纯数据**：title/url/query 等原样传递，UI 层之外的任何 slice 截断都是错的——截断只发生在渲染出口一处。

## 模块清单（导入出口）

| 模块 | 职责 | 正典导出 |
|---|---|---|
| `width.ts` | 宽度安全唯一出口：capPlain / structRow / clipTail / **safeTitle**（度量用 pi-tui 的 visibleWidth） | 全部 |
| `context.ts` | LLM context 保护：stashOverflow（截断 + /tmp 落盘）+ truncationMarker | 全部 |
| `spinner.ts` | Spinner 动画 + formatDuration/durationMeta；**兼容转发** width 的 clipTail/safeTitle（新代码一律从 `width.js` 导入） | 全部 |
| `ticker.ts` | 共享动画时钟（多订阅最小间隔聚合） | ticker / TickerHandle |
| `widget.ts` | 前台状态指示器（Agents 条、进度 meta、idle 行） | StatusWidget / **counterParts**（计数词汇单源）等 |
| `card.ts` / `view.ts` | 视图族：卡片积木 + createToolView 声明工厂 | 见各自文件 |
| `preview-runtime.ts` | **dev-only** storybook 运行时：主题深加载 hack + 框架 shell 模拟（生产代码禁止导入） | createPreviewRuntime |

无 index 桶文件——按模块深路径导入，树摇友好且职责自明。

## 折叠语义

折叠永不丢内容：预览预算内显示尾部 + 展开提示（对齐 bash 工具的输出预算）；展开后全量渲染。只有进 LLM context 的文本才做截断（见根 SPEC），用户始终可展开看全部。
