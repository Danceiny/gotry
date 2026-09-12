[English](itinerary-html-renderer.md) | [简体中文](itinerary-html-renderer.zh-CN.md)

# 行程 HTML 渲染器(issue #442,父 #438)

> 定位/Role:纯行程 HTML 渲染器 `ts/src/itinerary-html.ts` 的运行时契约、证据纪律与拒绝集,外加喂给它的产品生成入口 `ts/capabilities/itinerary-artifact.ts`。
> 状态/Status:内部切片(2026-09-12)。渲染器已可从真实产品路径到达(注册工具 `gotry_itinerary_render` → 会话工作目录内的一个新 HTML 文件)。浏览器/原生预览验收与真实 Lavish 编辑反馈闭环仍留在父 #438 / #443 未完成面。
> 上游/Upstream:issue [#442](https://github.com/Danceiny/gotry/issues/442)(父 #438)、`docs/design/external-event-seam.md` 的「先合同后启用」范式,以及事实模型 `ts/src/bookable-facts.ts`。
> 下游/Downstream:`ts/scripts/itinerary-html-tests.ts`、`ts/scripts/itinerary-artifact-tests.ts`,以及再次查看生成产物的产物列表/阅读旅程。

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

- 计划住宿卡只给计划字段与一条指向独立事实的指针;酒店事实渲染在独立的「目的地级酒店事实」区。只有目的地与入住/退房两个日期都完全一致的事实才挂到该住宿;其它档期的证据留在独立区。因此「目的地 + 档期」的库存命中不可能被读成「这家选定的酒店有房」。
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

## 5. 产品生成入口

注册工具 `gotry_itinerary_render`(`ts/capabilities/itinerary-artifact.ts`)是唯一写出行程文档的产品路径。调用形状:`title`、显式 `itinerary` 对象(与渲染器同形,不接受夜数/预算字段)与 `fact_ids`(必填字符串数组,允许空),外加可选 `basename`。

- **事实只来自注册表。** 工具从不接收调用方自带的事实对象、不读 Markdown、不猜事实。选中的 id 对当前 `config.stateRoot` 事实日志(`loadFactRegistry`)解析;未知、重复与超量 id 一律拒绝,登记行畸形则由渲染器的运行时校验拒绝,不静默丢弃。
- **空 `fact_ids` 是合法输入**,渲染为明确未核验的计划:文档写明缺失的证据,且不带任何整体「已验证」徽章——只有逐条事实自带的可下单性/证据层/来源标注。
- **只新建文件,绝不覆盖。** 目标 = realpath 化后的会话工作目录顶层;basename 必须匹配 `gotry-itinerary-<ASCII token>.html`(无分隔符、无 `..`),否则自动生成 crypto 随机名。会话工作目录必须**显式给出且为绝对路径**:缺失、空白、纯空白或相对的 cwd 在工具边界 fail closed,能力层再次拒绝——刻意不回落进程 cwd,因为「猜落点」正是文档被写进无关目录的方式。文件以 `O_CREAT|O_EXCL`(`wx`)创建:既有文件与指向别处的符号链接都会失败,不会被跟随或替换;`.git`/`node_modules` 目录拒绝。写入只落在会话工作目录,绝不写进 `stateRoot`。
- **失败即零字节。** 非法输入、未注册 id、渲染被拒、文件名被占用与被拒目录都在打开任何文件之前返回结构化错误。结果返回落盘文件的最终真实路径;本工具只做本地文档生成——不预订、不支付、不写供应商。
- **再次查看的旅程。** 生成的 `.html` 经 `gotry_artifacts_list` / `gotry_artifacts_read` 发现与阅读(源码卡文本视图)。宿主自带的原生 HTML 预览是另一个 UI 面、有自己的 sandbox 行为,本文不作声明。

## 6. 切片状态

本切片已落地:渲染器、生成入口(注册工具 + run-all §6c 两套件)与本文件。仍属 #438/#443 未完成面:生成产物的浏览器验收(导航、展开、窄屏、转义)、原生预览的实际 sandbox 行为,以及真实 Lavish 编辑反馈闭环。生成产物是「调用方给的显式结构 + 已注册事实」的投影——其 fixture 不是供应商证据,不能替代真实库存核验。
