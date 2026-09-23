[English](itinerary-deck-renderer.md) | [简体中文](itinerary-deck-renderer.zh-CN.md)

# 行程 deck 渲染器（issue #564）

> 定位：纯 deck 渲染器 `ts/src/itinerary-deck.ts` 的运行时契约、幻灯页确定性派生与决策日志，连同两个投影共同立足的共享文档契约层 `ts/src/itinerary-doc-shared.ts`。
> 状态：内部切片（2026-09-23）。渲染器是纯函数，本切片没有产品入口——没有任何注册工具写 deck 文件；产品路径、静态导出与 QR 属于 issue #564 的后续切片。
> 上游：issue #564；[karpo-deck-web 参考研究](../research/karpo-deck-web-research.zh-CN.md)借鉴决策 #1；契约词汇继承自 [itinerary-html-renderer.md](itinerary-html-renderer.zh-CN.md)。
> 下游：`ts/scripts/itinerary-deck-tests.ts`（run-all §6d）；后续 deck 产品入口／静态导出切片；后续阶段的设计系统种子。

## 速览（TL;DR）

- `renderItineraryDeck(input: unknown)` 从与单页文档完全相同的显式行程＋已注册事实，渲染出一个自包含的幻灯 HTML——是同一模型的另一种投影，不是另一份实现。
- 契约与 `renderItineraryHtml` 完全同形：纯函数、有界、fail-closed、零脚本、无远程资源、无算术，共用同一 2 MiB 字节上限。
- 幻灯页**确定性派生，不接受调用方编排**：封面 → 按日期 → 每交通段一页 → 每住宿一页 → 住宿证据 → 政策（仅有政策事实时）→ 证据附录 → 全部航班／车次事实。
- 翻页是纯 CSS scroll-snap（`y proximity`），页码用 CSS counter；脚本化 deck 的疑问（研究决策点 D-2）以零脚本了断——不开 ADR 例外。
- 单一事实源：输入校验、事实归一化、证据卡与双面文案全部住在 `itinerary-doc-shared.ts`；反漂移锁测试断言两个投影对同一畸形输入给出逐字节一致的 errors 数组。

## 1. 契约

```ts
renderItineraryDeck(input: unknown):
  | { ok: true; html: string }
  | { ok: false; errors: string[] }
```

`input` 携带标题、显式行程（`trip_start` / `trip_end` / `stays` / `od_segments`）与调用方从注册表选出的事实——与单页渲染器完全同形。渲染器不查询上游、不读时钟、不解析 Markdown、不做夜数／预算／时间运算。输出是一个自包含 HTML 文档：inline CSS、零 `<script>`、无远程资源，外加 deck 版式（scroll-snap 幻灯、sticky 锚点导航、打印分页）。

## 2. 两条永不合流的证据面（继承，不重述）

计划面（显式住宿／交通段）与证据面（带 tier/bookability/source/query_id/fetched_at/as_of 的已注册 `BookableFact`）与单页文档是同一对双面，由同一批共享函数渲染。目的地＋档期级库存命中绝不会被读成「这家酒店有房」；无任何整体 verified 徽章；缺价、缺时间、缺证据一律保持缺失。deck 是版式变化，不是语义变化。

## 3. 幻灯页确定性派生（deck spec）

幻灯列表是归一化输入的固定投影——不存在调用方可编排的 `slides` 字段：

| 顺序 | 幻灯 | 出现条件 |
|---|---|---|
| 1 | 封面：标题、行程窗、双面声明、证据边界声明、事实计数 | 恒有 |
| 2 | 按日期索引（住宿按入住日、交通段按出发日；不合成日历日） | 恒有 |
| 3.. | 每个 `od_segment` 一页（计划卡＋route+date 匹配的事实，负事实保留） | 每段 |
| .. | 每个住宿一页（计划卡＋完全一致档期的酒店事实指针） | 每住宿 |
| .. | 住宿证据：目的地级酒店事实，独立标题 | 恒有（含显式空态） |
| .. | 政策事实＋政策注脚 | 仅当存在政策事实 |
| .. | 证据附录：未被任何计划条目挂接的事实（自带空态） | 恒有 |
| .. | 全部航班／车次事实（含负事实与冲突，含显式空态） | 恒有 |

deck 导航是组级锚点链接，随派生收缩（不指向不存在的页）；逐段／逐住宿的导航由「按日期」页承担，与单页文档的 TOC 同一职责。

## 4. 决策日志

- **为什么幻灯页是派生的、不是调用方编排的**：可编排的 `slides` 字段会把组合权交给调用方，在 deck 层重新打开计划／证据合流的风险；派生让组合留在确定性投影内部。页列表因此是固定词汇，与渲染器的枚举封闭集同一性质。
- **为什么零脚本（研究 D-2）**：单页 inert-HTML 契约（在任何宿主、包括纯预览里都安全渲染）原样迁移。scroll-snap 翻页、页码（CSS counter）、每页打印分页都不需要一行 `<script>`；不需要开脚本化 deck 的 ADR 例外。
- **为什么是 scroll-snap `proximity` 而不是 `mandatory`**：比视口更高的幻灯页不能把读者卡在半截；`proximity` 保住吸附行为，又不让超长证据页不可滚动。
- **为什么页码用 CSS counter**：页码是版式不是数据；counter 让它免脚本自动生成，测试断言 counter CSS 而不是写死的逐页文本。
- **为什么共用一个字节上限和一张 LIMITS 表**：允许 deck 比单页文档占更多字节，等于奖励把数据改造成更宽敞的格式；字节上限是文档家族的属性，所以住在共享层。
- **为什么证据边界声明统一为「本文档」措辞**：共享的 `EVIDENCE_BOUNDARY_NOTICE` 被两个投影逐字使用；deck 是一份文档，封面说「本文档」。这是本切片对单页输出唯一一处刻意的措辞变化（被测试钉住的子串未受影响）。
- **为什么带打印分页**：deck 打印为一页一幻灯——在真正的导出切片落地之前，这是零成本的「打印成 PDF」路径。

## 5. 共享契约层（`ts/src/itinerary-doc-shared.ts`）

校验原语、事实归一化、事实卡、计划卡、证据区、日期索引与未匹配事实的组合、双面文案、基础组件 CSS，全部从 `itinerary-html.ts` 原样上移。理由：同一套校验或文案的任何第二份实现都会静默漂移——渲染器设计文档对算术已确立过同一推理。`itinerary-html.ts` 重导出 `ITINERARY_HTML_LIMITS` / `ItineraryHtmlInput` / `ItineraryHtmlResult`，既有消费方（`itinerary-artifact.ts`、既有套件）零改动；只有 §6 源码纯度检查拓宽到覆盖两个模块。

## 6. 拒绝集与反漂移锁

单页渲染器的每一条拒绝就是 deck 的拒绝，逐字节一致：两个入口调用同一个 `normalizeDocInput` 与同一个 `docBytesError`。deck 套件用反漂移锁钉住——对每个畸形输入用例（坏日期、坏枚举、坏事实 schema、倒置行程窗、零夜住宿、缺班次号、带错误上限的噪音输入），两个 `errors` 数组必须 `JSON.stringify` 逐字一致，且 `ok` 必须同翻转。任何未来只改一个投影的校验改动，都会在构造上就撞上这道闸。

## 7. 切片状态与显式不主张

本切片落地：共享层、deck 渲染器、确定性 deck 套件（226 断言，run-all §6d）、拓宽的源码纯度检查。

issue #566（Phase B 切片 2）落地：deck 产品入口 `ts/capabilities/itinerary-deck-artifact.ts`，暴露注册工具 `gotry_itinerary_deck_render`——与单页 `gotry_itinerary_render` 完全对称（共用 `normalizeDocInput` + 同一套注册表专属 / 独占新建 / 会话 cwd 路径护栏；basename 契约前缀改为 `gotry-deck-`）。由 `ts/scripts/itinerary-deck-artifact-tests.ts`（131 断言，run-all §6e）验证。

不在任何切片：静态导出／部署、QR、任何运行时激活、任何分享／同意面——都是 issue #564 的后续切片。deck 渲染器只渲染调用方给出的结构＋注册表选出的事实；其夹具为合成数据，不代表任何供应商证据。