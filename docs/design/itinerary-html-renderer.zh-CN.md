[English](itinerary-html-renderer.md) | [简体中文](itinerary-html-renderer.zh-CN.md)

# 行程 HTML 渲染器(issue #442,父 #438)

> 定位/Role:纯行程 HTML 渲染器 `ts/src/itinerary-html.ts` 的运行时契约、证据纪律与拒绝集。
> 状态/Status:proposal——内部切片(2026-09-12)。渲染器尚未进入产品调用链;接线归 #438 的后续集成切片所有。
> 上游/Upstream:issue [#442](https://github.com/Danceiny/gotry/issues/442)(父 #438)、`docs/design/external-event-seam.md` 的「先合同后启用」范式,以及事实模型 `ts/src/bookable-facts.ts`。
> 下游/Downstream:`ts/scripts/itinerary-html-tests.ts`,以及将来加载事实注册表并写出 HTML 产物的调用方。

## 1. 契约

渲染器是纯有界函数:无 IO、无服务、无 `Date.now`、无子进程、不解析 Markdown、不做算术。

```ts
renderItineraryHtml(input: unknown):
  | { ok: true; html: string }
  | { ok: false; errors: string[] }
```

输入含标题、显式行程(`trip_start` / `trip_end` / `stays` / `od_segments`)以及**调用方**从注册表选出的事实。渲染器从不查询上游。输出是一份自包含 HTML 文档:内联 CSS、语义导航锚点、原生 `details`/`summary` 展开、无脚本、无任何远端资源。

## 2. 两个永不合流的平面

- **计划面**——用户排期意图(`stays`、`od_segments`)。卡片一律标注为计划,不标注为可订。
- **证据面**——`BookableFact` 记录,逐条渲染自身的 `bookability`、`EvidenceTier`、`source`、`query_id`、`fetched_at`、`as_of`。

以下后果由代码结构保证,而不只靠文案:

- 计划住宿卡只给计划字段与一条指向独立事实的指针;酒店事实渲染在独立的「目的地级酒店事实」区。因此「目的地 + 档期」的库存命中不可能被读成「这家选定的酒店有房」。
- 不存在整体 verified 徽章。弱证据层(`route_exists`、`historical_schedule`、`benchmark_price`)或 `unverified` / `conflict` / `unavailable_exact_date` 状态一律按原样标注,绝不提升。
- 缺失的价格、时刻与证据保持缺失;不编造,也不产生跨币种合计。

## 3. 判定记录

- **为什么不从 Markdown 反解**:规划模型必须来自显式结构;从渲染后的文本重建规划模型正是事实闸要拦下的失败模式。
- **为什么夜数/预算算术不在这里**:evaluate 权威已经拥有该算术。第二份实现会静默漂移;渲染器干脆不接受承载这些关注点的字段。
- **为什么畸形输入失败而不是跳过**:静默丢掉一条住宿或一段行程,会产出「看起来完整却不完整」的文档。被拒绝的渲染可恢复;被悄悄截断的行程不可恢复。
- **为什么 HTML 里不放事实锚点(`fact:<id>`)**:那是 Markdown 产物闸的锚点。嵌入它会让整份 HTML 被当作带锚点的行来解析;事实 id 改为可见文本展示。
- **为什么没有浏览器端交互**:无脚本展开让产物在任何宿主(包括纯文本预览)中都是惰性的。

## 4. 有界输入,有界输出

以下情况一律显式报错:未知/缺失字段、类型错误、不受支持的 `mode` / `bookability` / `tier` / `verdict` / 事实 `schema`、不存在的日历日期(校验月长与闰年,不只校验形状)、畸形 ISO 时间戳、非有限或越界数值、超量数组与超长字符串、行程窗倒置、零夜住宿,以及渲染结果超过字节上限。错误文本绝不回显原始输入。

## 5. 切片状态

本切片已落地:模块、对应聚焦测试与本文件。仍属 #438 未完成面:产品接线、产物路径、导航/展开/窄屏/转义的浏览器 E2E、六处状态面与双语状态同步,以及根代理对集成链的审阅。本渲染器的静态 fixture 不是供应商证据,不能替代真实库存核验。
