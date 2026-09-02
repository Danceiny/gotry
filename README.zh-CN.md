[English](README.md) | [简体中文](README.zh-CN.md)

# GoTry

> **身体和灵魂,更多旅行,更少旅游。**
> *Body and soul — more travel, less tourism.*

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**:你用一句话说想去哪、为什么想出发;它先问清楚你的工作窗口和已订资源,再用 **Z3 数学求解器**给你一份经过形式化验证的行程方案——是算出来的,不是模型猜的。

[![CI](https://github.com/Danceiny/gotry/actions/workflows/ci.yml/badge.svg)](https://github.com/Danceiny/gotry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@danceiny/gotry)](https://www.npmjs.com/package/@danceiny/gotry)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.15-blue)](https://www.npmjs.com/package/@danceiny/gotry)
[![Docs](https://img.shields.io/badge/docs-architecture.md-blue)](docs/architecture.md)

**[它做什么](#它做什么)** · **[工作原理](#工作原理)** · **[工具](#工具)** · **[一段对话](#一段对话)** · **[快速开始](#快速开始)** · **[账号会话:授权与隐私](#账号会话授权与隐私)** · **[构造上可信](#构造上可信)** · **[状态与限制](#状态与限制)** · **[路线图](#路线图)** · **[给 AI Agent](#给-ai-agent)** · **[文档](#文档)** · **[License](#license)**

> **新读者提示**:一条命令就能感受差别——`npx @danceiny/gotry web`,打开 `http://127.0.0.1:3080`,说一句「我想去大理躺三天」。Agent 会先访谈你;然后由求解器(而非模型)判定什么可行。完整走查见 [`docs/user-guide.md`](docs/user-guide.md)。

## 它做什么

GoTry 把「想去哪」变成「能不能——怎么去、真实代价是多少」。当答案是「这周末不行」时,目的地连同成行条件进愿望池接住,而不是被丢掉。

- **给旅行者** —— 一个先问对人问题(工作窗口/已订资源/出发城市/预算)的对话规划器,然后逐目的地给判决:可行/不可行、为什么、以及**让它可行的最小改动**。
- **给 Agent 工程师** —— 一个「LLM 只负责听懂、翻译、解释」的落地样本:判定与算术在 Z3 求解器里,交付物里每个数字都带来源标签,写操作从设计上就是被闸住的。
- **证据内建** —— 估算绝不冒充实时。标签由渲染层附加、模型无权染指;降级时标签如实更换。回溯不到 exact-date 工具结果的可下单 claim,交付前就被拦下。

## 工作原理

一次规划是一条流水线:模型只占语言密集的两端,数值全部归求解器:

| 阶段 | 由谁做 | 给你什么 |
|---|---|---|
| 动机访谈 | LLM | 必问项:工作窗口 / 已订资源 / 出发城市 |
| 事实抽取 | LLM | 工作窗口生效 + 休假语义识别 |
| 可行性判决 | **Z3 求解器** | 哪些候选可行/不可行、为什么、**最小改动让它可行** |
| 门到门全成本 | 求解器 | 真实飞行时长(含时差)+ 早起惩罚 + 接驳代价 + 到达精力 % |
| 证据链 | 渲染层 | 每个数字都带来源标签 |
| 交付闸 | 事实闸 | 可下单 claim 必须回溯到 exact-date 工具结果,否则产物 blocked |
| 记忆 | 领域层 | 当下不可行 → 愿望池,附显式召回条件 |

在 GoTry 的回答里会遇到的词汇:

- **证据标签** —— `[骨架:openflights]` 航线存在性经公开航线库校验;`[实时API:...]` 刚从实时接口拉回数秒;`[静态包:估算]` 调研估算——非实时,下单前请核实。降级时标签如实更换。
- **门到门全成本** —— 票价之外,这段旅程真正从你身上拿走的东西:跨时区的真实时长、早起惩罚、接驳、落地时的精力余额。
- **愿望池** —— 「下一次出发」的存储。装不下的憧憬带显式条件(如「5 天+、淡季」)入池,条件满足时被召回。
- **事实闸** —— 行程产物交付前闸:每条可下单 claim(航班号/时刻/机场/价格/政策)必须回溯到 exact-date 工具结果;回溯不到即 blocked——绝不宣称「已验证方案」。

架构五层:

```
┌──────────────────────────────────────────────────────────────┐
│ L1  对话即界面  chat-as-UI; gates 是消息内选择题                 │
│ L2  编排  dsh 运行时 + GoTry 插件(ReAct);21 个工具            │
│ L3  领域  统一行程模型 + Z3 可行性引擎                          │
│ L4  数据  静态数据包 + hotelbyte-cli 实时桥 + OpenFlights 骨架 │
│ L5  治理  LoopX(objective / gates / evidence / quota)         │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 模块 | 角色 |
|---|---|---|
| L2 | `ts/src/index.ts`(dsh 插件) | 注册 21 工具,挂时间锚点/记忆 brief 变量;execute 异常隔离 + 授权闸 + 每轮工具预算 + 进程护栏 |
| L3 | `ts/src/unified.ts` · `py/gotry_feasibility/` | 唯一求解入口(候选枚举 + 航班链 Z3) |
| L4 | `ts/capabilities/effect.ts` · `hbcli.ts` · `skeleton-check.ts` | 效应解译层(退避重试/断路器/mock 解译器)+ 实时库存桥 + OpenFlights 骨架(三值语义) |
| L5 | loopx 治理面 | objective / gates / evidence / quota |

> 完整 ADR / 演进 / 债务清单:[`docs/architecture.md`](docs/architecture.md)(英文版计划 v0.1.0)。

## 工具

六组共 21 个:

| 组 | 工具 | 干什么 |
|---|---|---|
| **实时检索(OTA/官方只读)** | `gotry_flyai_search` | 机票/火车/酒店实时报价(飞猪官方通道;酒店价格为上游打码展示,真实价以 jumpUrl 为准) |
| | `gotry_session_search` | 在**用户本人登录态**里查携程机票(授权后,只读) |
| | `gotry_session_login` | 登录引导:自动检测已登录与否,未登录才在用户 Chrome 弹登录入口(**零终端**) |
| | `gotry_weather_check` | Open-Meteo 预报≤16 天 + 历史气候基线 |
| | `gotry_flight_verify` | OpenSky ADS-B 航班实时观测(三值) |
| | `gotry_skeleton_check` | OpenFlights 168 对枢纽通航性(三值) |
| **库存与目录** | `gotry_hotel_search` | hotel-byte 实时桥,降级静态包(证据标注) |
| | `gotry_anything_search` | 城市/酒店/地标混合目录(hotel-be Anything) |
| **判定引擎** | `gotry_feasibility_check` | 门到门真成本可行性(Z3),逐候选判定 |
| **记忆与触达** | `gotry_motivation_save` | 动机画像落盘(evidence 强制,反幻觉) |
| | `gotry_wish_pool_add` / `gotry_wish_pool_list` | 「下一次出发」愿望池 + 0..1 条件召回 |
| | `gotry_companion_save` · `gotry_trip_log` | 同行人档案 / 旅行时间线 |
| **产物** | `gotry_artifacts_list` / `gotry_artifacts_read` | 发现与查看已生成的产物(异步交付 + 工作目录 markdown),行号文件视图,只读 |
| **事实闸** | `gotry_fact_gate` | 行程产物交付前闸——见上文[工作原理](#工作原理)中的定义 |
| **通用外部** | `gotry_web_search` · `gotry_video_subtitle` · `gotry_github_search` · `gotry_agent_reach` | 网页/字幕/GitHub/全渠道外部信息(经 Agent-Reach) |

## 一段对话

```
> 我想去洱海边发呆两三天,上海出发,预算 3000,年假别让我办公。

GoTry: 收到。先把约束记下来——
  • 窗口: 2 天  • 出发: 上海  • 预算: ¥3000 全含
  • 动机: 休整 / [escape_rest: 0.7]  • 还没订任何东西

引擎判定:
  **大理·洱海: 现在不行** —— 2 天窗口装不下「至少 5 天的洱海休整」。
    放宽方案: 行程延长到 5 天,约 ¥4950。★已放入「下一次出发」清单。
  **千岛湖: 可行** (G7315 06:35 出发,¥996,到达精力 84%,有效休整 4.4h)
  **太湖: 可行** (G101 09:00 出发,¥716,有效休整 4.6h)
  建议: 千岛湖(意象匹配 80%)。

[骨架:openflights] ✓ SZX↔PVG 已校验 [实时API:hbcli] 上海机场在跑
[静态包:估算] G7315/G7316 价格按 7-8 月淡季估算
```

> 标签导读:`[骨架:openflights]` 说的是"这条航线能飞"已被公开航线数据校验;`[实时API:*]` 说的是刚从实时接口拉回的当下数据;`[静态包:估算]` 提醒价格是淡季档估算——**订前核实**。标签由渲染层附加,模型无权染指。

## 快速开始

### npm(推荐)

```bash
npx @danceiny/gotry web
# → 浏览器打开 http://127.0.0.1:3080,说「我想去大理躺三天」
# LLM key & 模型:由 dsh 宿主 UI 配;gotry 在 CLI 层完全不出声,不要求也不回显任何凭证
```

| 入口 | 命令 | 什么时候用 |
|---|---|---|
| Web 对话(推荐) | `npx @danceiny/gotry web` | 持续多轮规划,看推理可视化 → `:3080` |
| headless 一问一答 | `npx @danceiny/gotry "我想从深圳休整两天,预算 3000"` | 脚本 / CI / 定向调试 → stdout |

前置:Node ≥ 22.15。LLM 凭证由 dsh 宿主 UI 配,OpenAI 兼容端点(MiniMax/中转/自建网关)走 dsh 的模型设置。首启 6–15 秒属正常冷启动;`:3080` 被占先腾端口;异常退出会留证据到 `gotry-state/incidents.jsonl`(不静默)。

> **成本核算** —— `ts/data/llm-price-table.json`(schema `gotry_llm_price_table_v2`)是 nightly 成本核算的唯一事实源。新增模型或换中转=对该文件提 PR(peak 保守上界只高不低);未知模型 **fail-closed 不猜价**。漂移监测:`npx tsx ts/scripts/price-drift-watch.ts`(默认离线对照 baseline;`--fetch` 拉官方页)。**永不自动 apply 价格**。

### 开发者源码安装

```bash
git clone https://github.com/Danceiny/gotry && cd gotry
npm ci && npm --prefix ts ci                      # 锁定的 root/TS 依赖闭包
node scripts/build-dist.mjs                       # 构建 JS runtime
./gotry web                                       # 仓内入口,与 npm 形态同 UX
```

源码入口与 npm 包解析同一组 216 个精确直接依赖的 DSH `0.1.2-alpha.3` closure(publish preverify 拒绝漏钉、混版和 range)。源码普通运行状态落在 `ts/dsh-runtime/gotry-state/`;benchmark opt-in 与 npm 包运行用调用目录隔离。

## 账号会话:授权与隐私

账号会话通道用**你本人已登录的 Chrome**读酒店/机票实时数据,为此立了四条 hard 规则:

1. **登录在外部网站完成** —— gotry 从不提供、不代填、不收集任何密码/验证码/cookie 值。它只回答一个布尔问题:"登录票据 cookie 存在吗"(只读**名字**,0 值过手)。已登录会被自动识别,零弹窗。
2. **授权卡,每会话一次** —— 首次动用账号会话弹运行时审批卡;批准后会话内记住,拒绝即本会话吊销,不再打扰。总闸 `sessionAccess: ask|allow|off` 随时可关。
3. **物理只读** —— ReadGuard 在网络层中止一切写请求(下单/支付在传输层不可达);agent 永不接触凭证与验证码,遇验证码立即停、交还给你。
4. **绝不劫持你的浏览器** —— 检索/登录只开自己的独立标签页,登录页置前台、留在你那;例行动测试永不自动开浏览器窗。

前置(一次性):[GoTry Session Bridge](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) Chrome 应用商店一键装(自动更新)。账号会话工具首次需要扩展时,**由 dsh 宿主 UI 把商店 URL 作为可点链接渲染**;gotry 这边不会跑任何 setup wizard、也不会让你手动加载已解压扩展。装完**零系统弹窗**——扩展只被动转发站点自己发出的检索响应(构造上只读;cookie 只读名字,值永不离开浏览器);后台 health-watch 探活,扩展一就位自动重放你的检索。未安装时工具返回 `needs-extension` 并把商店链接置于 verdict,不消耗执行配额。

## 构造上可信

1. **模型只翻译,求解器才判决** —— LLM 永远不产出可行性判决与算术;那些由 Z3 基于抽取事实计算。
2. **每个数字带来源标签** —— 由渲染层附加,模型无权染指;降级时如实更换,估算绝不冒充实时。
3. **不存在写路径** —— 预订/支付类工具必须先过 WriteGate 才允许实现;未来的预订缝已被 `booking_saga_fsm.v1` 边表钉住。
4. **登录永不碰凭证** —— 登录发生在外部网站;gotry 只读 cookie 名;授权每会话问一次、可吊销。
5. **检索物理只读** —— ReadGuard 在网络层中止写请求;验证码让 agent 停下、把控制权交还给你。
6. **回溯不到就是 blocked** —— 事实闸拒绝交付任何可下单 claim 无法回溯到 exact-date 工具结果的行程——绝不宣称「已验证方案」。
7. **价格 fail-closed** —— 未知模型不猜价;价表只经 PR 变更;漂移监测只报告、永不自动 apply。
8. **你的数据是你的** —— 产品状态在 `gotry-state/`;自动化测试与 smoke 用隔离 state root,永不写创始人的真实产品数据。

## 状态与限制

当前版本:**v0.0.1-rc.17**(npm dist-tag `rc`;`latest` 仍指 rc.16,沿用 dsh-管-LLM 安装口径)。评测处于 Phase 0 基座——确定性合同、校验器与节奏策略;无外部 benchmark 分数、无花费、无 uplift 声明。

**今天可用**(全栈回归全绿;每项都有确定性测试):

- **Z3 求解引擎** —— 可行性判决 + 门到门全成本;历史并发竞态已根治并进回归闸
- **实时检索** —— 机票/火车/酒店(飞猪官方通道)、目的地/酒店目录、天气、航班观测、通航性校验;实时票价可覆写求解价(`GOTRY_REALTIME_PRICING=1`)
- **账号会话检索** —— 你本人登录态查携程机票;观测轮次中所有可评分 hit 全过、ReadGuard 零写,非 hit 保持显式 `miss` 记录——不作超出此口径的实时可售声明
- **扩展按需装** —— `[GoTry Session Bridge](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)` 由 dsh 宿主 UI 在账号会话工具首次需要时以可点链接给出(Chrome 商店一键装 + 自动更新);gotry 这边不跑 setup wizard、不开 chrome://extensions、不动剪贴板
- **记忆与触达** —— 动机画像 / 愿望池 / 同行人 / 旅行时间线;英文输出一键切换(`GOTRY_LOCALE=en`)
- **有界的工具循环** —— 16 次派发后注入软收敛,18 次后结构化 `TOOL_BUDGET_EXHAUSTED` 拒绝;经打包消费者安装的 E2E 在 CI 里实测

**已知限制**(诚实清单):

- **M3 Exit 未关闭** —— 工程与分发面就绪,但真实种子用户证据(50–200 人 cohort)尚未积累;自动化测试证明的是合同与公式,不是 business pass
- **酒店会话适配** —— 携程酒店/美团登录态面等实测回填;机票已通
- **界面语言** —— 英文仅覆盖求解确定性输出层;dsh 宿主界面与对话面属宿主/校准件
- **外部 benchmark 泛化** —— 迄今所有冻结外部运行均仅 diagnostic(无分数、无 uplift 声明);逐轮工程台账见 [`docs/benchmark-environment-bridge.md`](docs/benchmark-environment-bridge.md)
- **预订** —— 今天没有任何可下单路径;M5 只经 WriteGate 与 booking-saga 状态机启封

<details>
<summary>更深的工程状态(账本合同 / 证据合同 / 里程碑口径)</summary>

状态权威面在文档,不在 README:事务化状态账本(ADR-15)+ 双形态冻结(ADR-16:本地+Web 一套账本语义);M3 真实 cohort 证据合同已立(fixture 不充当 Exit,真实 50–200 人样本即开 Exit);M4 paired-cohort 价值证据合同(合成数据不充当 Exit 证据);异步工单终态合同(`gotry_async_terminal.v1`:4/4 → succeeded / ledger settled / exit 0)。细则见 [`docs/roadmap.md`](docs/roadmap.md) / [`docs/architecture.md`](docs/architecture.md) §1 与 #19–#22。

</details>

## 路线图

| # | 里程碑 | 范围 | 状态 |
|---|---|---|---|
| M0 | 确定性管道 | 引擎双实现 + 真实数据包 + 对账框架 | ✅ |
| M1 | Agent 形态成立 | LLM 进环;对话即界面;gates 选择题 | ✅ 2026-08-22 |
| M2 | 实时数据 | hotelbyte 桥 + 航班源;证据链换实时标签 | ✅ 2026-08-22 |
| M3 | 最小可用产品 | 最小 Web 面 + 50–200 种子用户(洱海/普吉场景) | **← 当前 —— evidence 未收口** |
| M4 | 记忆与「下一次出发」 | 六层记忆 C 端域;paired-cohort 价值证据 | founder 授权并行 |
| M5 | 交易闭环 | WriteGate 上生产;预订 / 支付 / 退改 | entry gate 启封 |
| M6 | B2B 包裹 | principal/sponsor 插件,内核零改动 | entry gate 启封 |

唯一权威时间线(逐里程碑的进入/退出条件、交付物与 gate):[`docs/roadmap.md`](docs/roadmap.md)。

## 跑测试

```bash
./scripts/run-all-tests.sh                     # 全栈套件(纯 TS,无 Python 依赖)
cd ts
npx tsx scripts/evaluation-contract-tests.ts   # 评测 Phase 0 合同(离线)
npx tsx scripts/evaluation-cadence-tests.ts    # 确定性节奏策略/planner
```

套件覆盖金标准引擎、对话重放、跨进程异步工单、插件 smoke、实时桥、进程护栏、i18n、记忆域、Z3 并发闸、事实闸、打包消费者工具预算 E2E 等;权威分节以 `scripts/run-all-tests.sh` 实际枚举为准。真实会话 benchmark(`npx tsx scripts/sf-live-benchmark.ts --golden=static`)为 opt-in,需你的 Chrome 会话扩展在线,永不进 CI。

## 参与开发

从最新 `main` 切出 `feat/ · fix/ · docs/ · chore/` 分支,本地全栈绿后开 Pull Request——`main` 不直接推。CI(Node 22/24,typecheck + 全部套件)与维护者 review 双绿后 squash 合入。**测试红着不许合。** 完整指南:[CONTRIBUTING.md](CONTRIBUTING.md)。Bug/功能建议:用 issue 模板(先搜既有 issue)。

## 给 AI Agent

如果你是在本仓工作的 agent,[`AGENTS.md`](AGENTS.md) 是绑定契约,先读它。要点:

- **入场先清扫异步工单**:`ts/gotry-state/async/*.json` 无同名 `.deliverable.md` → `cd ts && npx tsx scripts/async-collect.ts <id>`。
- **分层纪律**:算术只在 `model.ts` / `unified.py` 的 evaluate 层;求解只在 `unified.ts` / `unified.py`;`engine.*` / `journey.*` 是 deprecated 兼容层,新代码不得调用。改任何一侧必须跑全栈回归。
- **绝不写共享状态**:`ts/dsh-runtime/gotry-state/` 是创始人真实产品数据;验证写路径只用隔离 `stateRoot`。
- **状态同步纪律**:任何改变系统形态/状态/债务的提交,必须在同一提交内同步 `architecture.md` §11 六状态面;只暂存具名文件——禁止 `git add -A`。

程序层语境:[`docs/gotry-master-outline.md`](docs/gotry-master-outline.md)。技术权威面:[`docs/architecture.md`](docs/architecture.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 系统 / ADR / 演进 / 债务清单(中文,权威) |
| [`docs/gotry-master-outline.md`](docs/gotry-master-outline.md) | 总纲:工作分解 · 复用矩阵 |
| [`docs/gotry-product-design.md`](docs/gotry-product-design.md) | 产品设计:主循环 · 透明机制 · 全成本模型 |
| [`docs/roadmap.md`](docs/roadmap.md) | M0–M6 时间线与当前位置 |
| [`docs/user-guide.md`](docs/user-guide.md) | 终端用户使用指南 |
| [`docs/data-sources.md`](docs/data-sources.md) | 数据源与证据链政策 |
| [`docs/extension-privacy.md`](docs/extension-privacy.md) | Session Bridge 扩展隐私 |
| [`docs/benchmark-environment-bridge.md`](docs/benchmark-environment-bridge.md) | 外部 benchmark 桥——工程台账 |
| [`docs/evaluation-foundation.md`](docs/evaluation-foundation.md) | 评测 Phase 0 基座 |
| [`docs/booking-saga-fsm.md`](docs/booking-saga-fsm.md) | 预订 saga 状态机(M5 缝词汇) |
| [`docs/kimi-postmortem.md`](docs/kimi-postmortem.md) | 一次真实 AI 旅行规划失败复盘(反面教材) |
| [`docs/release-notes.md`](docs/release-notes.md) | 逐版本发布决策(「为什么」) |
| [`CHANGELOG.md`](CHANGELOG.md) | 机器衍生的变更日志(Keep a Changelog + Conventional Commits) |
| [`docs/tokens.md`](docs/tokens.md) | npm 2FA / 发布机制 |

## License

**MIT**——与上游 dsh 一致。文本见 [LICENSE](LICENSE)。

---

**Built with**: DeepSeek Harness 0.1.2-alpha.3 (root-pinned) · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 · OpenFlights · TypeScript

**版本基线:`v0.0.1-rc.17`(npm dist-tag `rc`;`latest` 沿用 rc.16)。** 当前 checkout 的权威验证闸以 `scripts/run-all-tests.sh` 实际枚举为准;发布流程见 `scripts/publish-npm.sh`。

---

## 中英版说明

- 本文件与 [README.md](README.md) 各自完整自含、结构互为镜像(常见开源双语布局)。
- `docs/` 深度工程文档当前中文先行,英文版计划 v0.1.0 同步。
