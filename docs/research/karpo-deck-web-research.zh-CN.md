[English](karpo-deck-web-research.md) | [简体中文](karpo-deck-web-research.zh-CN.md)

# Karpo Deck Web 参考研究 → gotry 成品感借鉴决策（2026-09-22）

> 状态：frozen（竞品参考研究，2026-09-22）。
> 对象：**karpo-deck-web.vercel.app** —— "Karpo"（一个 proactive AI 生活方式/体验发现产品）部署在 Next.js/Vercel 上的 pitch-deck 站点
> （观察到的 deck 内容提及：MachinePulse 平台、Karpo app、iMessage 集成、基于用户偏好与上下文的地点/活动主动推荐、
> QR CTA、Instagram/X 品牌面、新加坡 + 北美团队）。
> 本文只回答：**gotry 要长成这一类"成品"，哪些能力值得借、借成什么样、借到哪个里程碑、哪些明确不借**。所有结论
> 映射到现有接缝（itinerary HTML 渲染契约、external-event 事件接缝、愿望池、channel 注册表、consent 先例）。
> 本文不提出任何实现，不开 issue,不承诺任何运行时。
> 信源纪律：一手 = 站点自身的渲染内容（2026-09-21 单次抓取；观察到资产清单与链接图;JS 渲染的 SPA 通过其服务端
> 渲染文本与资产路径读取——docs、定价、登录、app 内部、推荐信源均不可观察）；二手 = 网络搜索（未找到独立
> 报道：无公开仓库、无媒体稿）。观察到的事实与推断分开标注;"proactive AI lifestyle" 的品类读法是站点自己的
> 定位话术，不是经过验证的厂商声明。

**前置判断**：karpo 卖感觉，gotry 卖真相。karpo 的 deck 验证了一个品类事实——AI 消费品可以被做成
**视觉可消费、可分享、可主动触发**。gotry 距离这一类成品感的差距不在内核,而在四块缺失的产品面
(deck 渲染、分享、主动触发、门面)加一套设计系统。本文的借鉴全部以「不稀释证据纪律」为约束:
fact gate、sealed 的 WriteGate、隐私铁律一概不动。

## 速览（TL;DR）

- **观察到了什么**:Next.js Image + Vercel 服务的一个 11 页 webp 幻灯 deck,收尾是一枚通往 iMessage 的 QR CTA;
  定位 "proactive AI lifestyle",带 MachinePulse 平台、一个 app、Instagram/X 品牌面。
- **它对 gotry 证明了什么**:成品感是渲染/分享/触发/门面的问题,不是内核的问题——gotry 已经握有向这些面
  扩展所需的每一个接缝。
- **六项借鉴决策**:继承 `itinerary-html.ts` 契约的行程 deck 渲染器;静态导出 + QR;作为 channel 注册表对偶的
  outbound 通知适配器;按 external-event 接缝自身落地序列激活的主动愿望池 feed;"Why we built GoTry" 落地页
  deck 加 fixture 驱动的 `gotry try` 演示;一套共享的设计系统与图卡。
- **四项明确不借**:无信源的主动推送、隐藏技术、iMessage 单通道、M3 出口之前的平台叙事。
- **里程碑纪律不变**:Phase A–C 是新的只读面,可服务尚未关闭的 M3 出口;主动触发(Phase D)是 M4 工程面,
  M3 证据期内不激活任何运行时。`roadmap.md` 仍是唯一时间线权威。
- **六个待拍板决策点**是 founder 决策队列的候选;本文不开 issue,不承诺实现。

## 决策总表

| # | karpo 面（观察到的） | gotry 决策 | 落点 / 接缝 |
|---|---|---|---|
| 1 | 幻灯站：Next.js Image + Vercel 上的 11 页 webp | **借其形态**（deck 渲染器提案;暂不写码） | 继承 `ts/src/itinerary-html.ts` 的纯渲染契约（见 [`itinerary-html-renderer.md`](../design/itinerary-html-renderer.zh-CN.md)）;unified model 与渲染之间加一个类型化的 deck spec;plan/evidence 双面在 spec 层保持不合并 |
| 2 | deck 收尾的 QR CTA（通往 iMessage） | **借其形态,门住触达** | 静态自包含导出 + QR 是渲染层扩展;分享本身需要一次同意卡,扩展 `session-consent.ts` 先例;构造上即去标识（只渲染注册事实） |
| 3 | "MachinePulse" proactive 平台 + app | **只借方向,不建新运行时** | external-event 接缝已写好这条词汇——"consume existing seams; build no new runtime"（[`external-event-seam.md`](../design/external-event-seam.zh-CN.md)）;其 §6 序列的段 1–2 已落地（本地探针 + 愿望池消费方）,剩余 producer 仍 trigger-gated;主动愿望池 feed 是该接缝自身 M4 形态的激活,不是一个新平台 |
| 4 | iMessage 集成 | **借通道家族,不借单一通道** | outbound 通知适配器作为 `channel-registry.ts` / `channel-health.ts` 的对偶（inbound 数据源 vs outbound 投递面）;默认关、需同意卡、内建 quiet-hours |
| 5 | Instagram/X 品牌面 | **部分借**（图卡管线） | 从现有 demo SVG 资产与双语 + dark/light 资产先例起步;deck、图卡、落地页共用一套设计系统 |
| 6 | "Why we built Karpo" 单页叙事 | **借其门面形态** | "Why we built GoTry" 的叙事已以散文形态存在于 [`gotry-product-design.md`](../gotry-product-design.zh-CN.md)（§2 旅游 vs 旅行;§1 三个差异点）;落地页 deck + fixture 驱动的 `gotry try` 是零内核面——纯渲染器天然可离线演示 |
| 7 | 主动推荐不带可见信源 | **明确不借** | 每条主动推送必须携带「为什么是现在」的触发解释与源标签;否则宁可不推（fact gate 红线） |
| 8 | 技术藏在生活方式文案背后 | **明确不借** | 确定性就是品牌:4.4% → 93%+ 的可行性对比（产品设计 §1）是 hero slide 素材,不是秘密 |
| 9 | 平台叙事先于公开证据发布 | **M3 出口之前明确不借** | `roadmap.md` M3 门:工程活动不能替代 50–200 用户的证据集;一张诚实的「我们正在验证」进度卡强过一个平台故事 |

## 参照对象是什么（观察记录,2026-09-21）

对 [karpo-deck-web.vercel.app](https://karpo-deck-web.vercel.app/) 的一手观察（单次抓取;SPA 内容通过服务端渲染文本与资产清单读取）:

| 观察 | 细节 |
|---|---|
| 部署 | Vercel（Next.js `/_next/image` 管线;观察到部署 id `dpl_HYwhfQEVbeTY9Gbif6imo5VgSqWJ`） |
| deck 形态 | 11 张幻灯图,`/images/page-01.webp` … `/images/page-11.webp` |
| 定位话术 | "proactive AI lifestyle";体验发现 "personal and effortless"（对渲染内容的转述） |
| 点名的面 | MachinePulse 平台;Karpo app;iMessage 集成;基于偏好与上下文的地点/活动主动推荐 |
| 出站链接 | `karpo.ai`, `instagram.com/karpo.ai`, `x.com/Karpo_AI`, 多条 Instagram reels |
| 收尾 CTA | QR 码,发短信给 Karpo（进入 iMessage） |
| 团队信号 | 新加坡与北美 |
| 不可观察 | docs、定价、登录、源仓库、推荐信源、app 内部 |

二手搜索未找到独立报道——无公开仓库、无媒体稿;本文对该产品的全部认知来自它自己的 deck。

**提取出的品类事实**（推断,已标注）:AI 消费品可以被做成*视觉可消费 + 可分享 + 可主动触发*。本文借的是
这个事实——不是 karpo 的领域（生活方式发现,与 gotry 的旅行规划相邻但不同）。

## 分维度借鉴决策

### 1. 行程 → 可分享 deck（借;渲染层扩展,不动内核）

渲染接缝已经以契约形态冻结（[`itinerary-html-renderer.md`](../design/itinerary-html-renderer.zh-CN.md)）: `renderItineraryHtml` 是
纯的有界函数——无 IO、无时钟、无子进程、无 Markdown 回解析、**零算术**;inline CSS、零脚本、无远程资源;
plan 面与 evidence 面永不合并;超大或畸形输入 fail-closed。

deck 是同一契约加一个页结构:unified model 与渲染之间的类型化 **deck spec**（页枚举、每页组件类型、证据徽章位）,
双面拆分在 spec 层强制执行,使任何 deck 页都无法把 plan 升级成 bookable。产品入口沿用 `itinerary-artifact.ts`
模式:只接受 registry 选出的事实、只写一个新文件、`O_CREAT|O_EXCL`、失败即零字节。

为什么排第一:它服务尚未关闭的 M3 出口——seed 用户拿到一个可炫耀的产物（finalization 与 NPS 的落点）;
而纯渲染器让 fixture 驱动的离线演示成为门面的可能。

### 2. 静态导出 + QR（借其形态;分享走同意门）

deck 产物按契约本就自包含;静态导出 + QR 是打包,不是新运行时。隐私立场原样迁移:该阶段不做托管后端,
任何 secret 不出门,分享产物只渲染注册事实。分享本身扩展同意卡先例（`session-consent.ts`:一次一卡、
拒绝即撤回、总开关）——被分享的 deck 构造上即去标识。

### 3. 主动愿望池 feed（只借方向;M4 工程面,归接缝所有）

接缝设计已写好规则:**consume existing seams; build no new runtime**（[`external-event-seam.md`](../design/external-event-seam.zh-CN.md)）。
其落地序列的段 1–2 已就位（本地 channel 探针作为 cron 驱动的只读 tick,与愿望池消费方）;剩余的 w2a sensor
producer 仍在 issue #82 下 trigger-gated。一个主动的 "next-departure feed" 正是该接缝自身 M4 形态的激活:
一个 tick 评估愿望池的 recall 条件,且每条推送携带**「为什么是现在」+ 源标签**——proactive with provenance,
这是 karpo 的 deck 没有展示、而 gotry 的 fact gate 必然要求的差异点。

里程碑纪律:M3 证据期内不做主动推送（`roadmap.md` M3/M4 门不变）;deck 上的 one-tap "Yes, plan it"
deep-link 回本地 session,不触碰任何写路径——WriteGate 保持 sealed。

### 4. Outbound 通知适配器（借家族,不借 iMessage）

gotry 的通道体系今天是 inbound 的（数据源与其健康度）。outbound 面是它的对偶:适配器
（iMessage、SMS、Slack、webhook）挂在同一个同意门后,默认关、内建 quiet-hours、失败有界静默重试。
iMessage 是第一个候选适配器,因为 karpo 演示了这个模式,不是因为它是唯一通道。

### 5. 门面:落地页 deck + `gotry try`（借;零内核）

- "Why we built GoTry":叙事已以散文存在于 [`gotry-product-design.md`](../gotry-product-design.zh-CN.md);落地页 deck
  是那段散文的重渲染——按文档双语对纪律天然双语,任意静态托管可部署。
- Benchmark 对比卡:persona-bench 对比今天是 README 素材;三张并排卡（"generic 助手 / OTA agent / GoTry"）
  把它渲染给非技术读者。
- `gotry try`:一个固定 fixture → 纯 deck 渲染器 → 内嵌的静态演示;免 npm 安装、免网络、免 LLM key——
  恰恰因为渲染器是纯函数,这才可能。
- M3 进度卡:"我们正在验证,证据开放"——诚实的状态本身作为品牌面,用 roadmap 自己的门语言。

### 6. 信任作为可见面（借一个 karpo 缺失的形态）

gotry 的结构性信任已是产品级素材:证据徽章（源标签今天已由渲染层持有）、no-write 承诺卡
（WriteGate sealed 状态渲染成 "我们不会替你预订或付款"）、"I don't know" 卡片（fact gate 拦下的内容
渲染成引导而非静默）、佣金披露位（产品设计 §1 机制;M5 之前渲染为 "我们目前不从中赚钱"）。

## 明确不借清单

| # | karpo 做法 | gotry 为什么不借 |
|---|---|---|
| 1 | 主动推送不带可见信源 | fact gate 永不让不可追溯的说法以 verified 之名出货;一条没有「为什么是现在」+ 源标签的推送,正是通知形态下的同一种违规 |
| 2 | 技术藏在生活方式文案背后 | 确定可行性是差异点（产品设计 §1: 4.4% → 93%+）;藏起来等于擦掉护城河 |
| 3 | iMessage 作为唯一集成通道 | gotry 的通道词汇是一张注册表,不是一个单点集成;outbound 适配器以家族形态出货 |
| 4 | 平台叙事先于公开证据 | M3 出口门是一个真实的 50–200 用户证据集（`roadmap.md`）;"我们正在验证"强过"我们是一个平台" |

## 顺序提案（候选;权威仍在 roadmap）

| Phase | 内容 | 动内核? | 里程碑匹配 |
|---|---|---|---|
| A | `gotry try` 离线 demo fixture（#571）：固定合成行程 + 空 fact_ids → `renderItineraryDeck` → tmpdir 落盘 + stdout 路径/字节/幻灯数；零安装零 LLM key 零 dsh 主机 | 否——纯新增面 | 服务 M3 种子用户漏斗 |
| B | deck spec + deck 渲染器（继承 `itinerary-html.ts` 契约）+ 静态导出 + QR（#569 经 npm `qrcode` 落真矩阵） | 否——渲染层扩展 | M3 |
| C | 分享同意卡 + token + outbound 适配器（issue #573 切片 1：4 个 no-op adapter stub + HMAC token + consent 状态机 + shareDeck 编排；M4 切片替换 stub + 接 dsh 工具注册） | 否——只读投递面 | M3→M4 |
| D | 召回触发契约层（issue #577：tick source + 5 类 RecallReason 评估器 + source tag 必现的 why-now 卡；PeriodicTickSource 默认关；不推送、不 mutation——M4 接接缝 producer） | 仅接缝激活，按 external-event 接缝自身的门控 | M4 工程面 |
| E | ~~one-tap deep-link 回本地 session~~——契约层已落地:签名 schema 闭集 `session-link` token + plan-it 行动卡（issue #580;切片 1 已合并,run-all §6j）;托管分享服务（独立决策）仍开放 | 无写路径;WriteGate 不动 | M4+（契约）,M4（消费端激活） |

每个 Phase 都沿用仓库既有模式:contract first, activation later;一个 slice 一个 PR;双语成对同 commit;红测试不合。

## 待拍板决策点（founder 决策队列的候选）

1. 分享的部署形态:先纯静态（本文推荐）,托管只读服务作为独立的里程碑级决策。
2. deck 零脚本契约:保持 inert-HTML 契约 + 纯 CSS 翻页（推荐）,还是开一个显式的脚本例外 ADR。
3. outbound 同意模型:默认关、一次一卡、内建 quiet-hours——比 inbound 先例更强的节制默认。
4. 主动层的里程碑归属:确认 Phase D–E 在 M3 出口达成之前保持 M4 工程面。
5. 落地页仓属:本仓 `web/site/`（复用双语与 CI 纪律）vs 独立仓（发布解耦）。
6. 托管原子边界:若托管面未来需要城市搜索/酒店静态数据等原子能力,按产品设计 §0 复用 hotel-be;gotry 不自建第二栈。

## 参考文献

- 一手: [karpo-deck-web.vercel.app](https://karpo-deck-web.vercel.app/),2026-09-21 抓取——渲染内容与资产清单如上记录;单次抓取。
- [`docs/design/itinerary-html-renderer.md`](../design/itinerary-html-renderer.zh-CN.md) —— 本文提议继承的渲染契约。
- [`docs/design/external-event-seam.md`](../design/external-event-seam.zh-CN.md) —— 主动方向的接缝权威。
- [`docs/roadmap.md`](../roadmap.zh-CN.md) —— 唯一时间线权威;全文引用其里程碑门。
- [`docs/gotry-product-design.md`](../gotry-product-design.zh-CN.md) —— 使命、旅游 vs 旅行叙事、透明机制。
- [`docs/architecture.md`](../architecture.zh-CN.md) —— ADR 索引与任何采纳的文档权威。