# GoTry

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Danceiny/gotry/actions/workflows/ci.yml/badge.svg)](https://github.com/Danceiny/gotry/actions/workflows/ci.yml)

> **身体和灵魂,更多旅行,更少旅游。**
> *Body and soul — more travel, less tourism.*

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**:你用一句话说想去哪、为什么想出发;它先问清楚你的工作时间和已订资源,再用**数学求解器**给你一份经过验证的行程方案。

**GoTry is an AI travel agent for departure-to-next-departure.** Tell it where you want to go and why. It asks what's missing, then hands you a **formally verified itinerary** — not vibes.

---

## 🚀 30 秒上手

```bash
npx @danceiny/gotry web
# 首跑会提示建 .env:LLM_API_KEY=<DeepSeek key 或 OpenAI 兼容 key>
# → 浏览器打开 http://127.0.0.1:3080,像聊天一样说「我想去大理三天」
```

> **换模型 / 换中转?** 价表(`ts/data/llm-price-table.json`,schema `gotry_llm_price_table_v2`)是 `gotry_m3_nightly_run_v1.cost_usd` 唯一事实源(ADR-11)。新增模型或换中转=改本文件走 PR(peak 保守上界只高不低),未知模型 → **fail-closed 不猜价**。漂移监测:`npx tsx ts/scripts/price-drift-watch.ts`(默认离线对照 baseline 比对输出 PR-就绪 Markdown diff;`--fetch` 拉取官方页 + 首次写 fixture)。**永不自动 apply 价格**。

| 你想要的 | 命令 |
|---|---|
| 🖥️ 对话规划(推荐) | `npx @danceiny/gotry web` → :3080 对话界面 |
| 🤖 脚本/一次性问答 | `npx @danceiny/gotry "我想从深圳休整两天,预算 3000"` |
| 🛠️ 开发者:仓内运行 | 见下方[源码安装](#-快速开始) |

- 前置:Node 22+;一个 LLM API key。零成本启动——dsh 运行时以 cordis patch 自动挂载,无额外配置。
- 例外提示:`:3080` 端口被占时先 `kill <PID>`;首启 6–15 秒属正常冷启动;异常退出会留证据到 `gotry-state/incidents.jsonl`(不静默)。

<details>
<summary>🛠️ 开发者:源码安装(仓内运行)</summary>

```bash
git clone https://github.com/Danceiny/gotry && cd gotry
cd ts/dsh-runtime && pnpm install && cd ../..    # ① vendored dsh 0.1.2-alpha.1(一次性)
cp .env.example .env                              # ② 填 LLM_API_KEY
./gotry web                                       # ③ 仓内入口,同 npm 形态
```

| 入口 | 命令 | 什么时候用 |
|---|---|---|
| dsh Web 对话(推荐) | `./gotry web` | 持续多轮规划,看推理可视化 → :3080 |
| headless 一问一答 | `./gotry "一句任务"` | 脚本 / CI / 定向调试 → stdout |
| help | `./gotry help` | 三行帮助 |

为什么源码模式要先装 runtime:dsh 以 vendored tarball 进 git(`ts/dsh-runtime/`),npm 一键分发不打包它;源码检出读 `.ts` 源码,装完一次重复可用。

</details>

---

## ✨ 它做什么 — What it does

GoTry 把「想去哪」变成「能不能、怎么去」:

| 阶段 | 由谁做 | 给你什么 |
|---|---|---|
| **动机访谈** | LLM | 必问项:工作窗口 / 已订资源 / 出发城市 |
| **事实抽取** | LLM | 工作窗口生效 + 休假语义识别 |
| **可行性判定** | **Z3 求解器** | 哪些候选可行、哪些不可行、为什么、**最小改动让它可行** |
| **门到门全成本** | 求解器 | 真实飞行时长(含时差)+ 醒来起夜惩罚 + 接驳代价 + 到达精力 % |
| **证据链** | 渲染层 | 每个数字都带**来源标签**:`[骨架:openflights]`=公开航线数据校验过"这条线能飞";`[实时API:flyai]`=刚从实时接口拉的现价现况;`[静态包:估算]`=非实时的调研估算(**下单前请核实**)。降级时标签如实更换,估算绝不冒充实时 |

**不像普通 AI 聊天**——LLM 只做理解和解释,**判定与算术是数学求解器**算的。

> **Unlike a regular AI chat**, the LLM only translates and explains. **Decisions and arithmetic are computed by a Z3 solver**, not guessed.

---

## 🎬 一段对话 — Demo

输入 → 引擎判定 → 输出(真实输出,milliseconds 保留原味):

```
> 我想去洱海边发呆两三天,上海出发,预算 3000,年假别让我办公。

GoTry: 收到。先把约束记下来——
  • 窗口: 2 天(2026 年窗口)  • 出发: 上海  • 预算: ¥3000 全含
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

> 标签导读:`[骨架:openflights]` 说的是"这条航线能飞"已被公开航线数据校验;`[实时API:*]` 说的是刚从实时接口拉回的当下数据;`[静态包:估算]` 提醒价格是淡季档估算——**订前核实**。

> **Brief English summary**: input → engine verdicts (feasibility + whole-cost) → recommendation + wish-pool entry for infeasible candidates. Every numeric carries an evidence tag. See the 证据链 row above for what each tag means.

---

## 🧰 21 个工具 — Tools

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
| **事实闸** | `gotry_fact_gate` | 行程产物交付前闸:每条可下单 claim(航班号/时刻/机场/价格/政策)必须回溯到 exact-date 工具结果(hit/miss 均落账);无法回溯 ⇒ blocked——不得宣称「已验证方案」 |
| **通用外部** | `gotry_web_search` · `gotry_video_subtitle` · `gotry_github_search` · `gotry_agent_reach` | 网页/字幕/GitHub/全渠道外部信息(经 Agent-Reach) |

---

## 🔐 账号会话:授权与隐私 — Account consent

会话检索使用**你本人已登录的 Chrome**读取酒店/机票实时数据,为此立了四条 hard 规则:

1. **登录在外部网站完成** —— gotry 从不提供、不代填、不收集任何密码/验证码/cookie 值。它只回答一个布尔问题:"登录票据 cookie 存在吗"(只读**名字**,0 值过手)。
2. **授权卡,每会话一次** —— 首次动用账号会话会弹运行时审批卡;批准后会话内记住,拒绝即本会话吊销,不再打扰。总闸 `sessionAccess: ask|allow|off` 随时可关。
3. **物理只读** —— ReadGuard 在网络层中止一切写请求(下单/支付在传输层不可达),agent 永不接触凭证与验证码;遇到验证码立即停,交还给你。
4. **绝不劫持你的浏览器** —— 检索/登录只开自己的独立标签页,登录页置前台、留在你那;例行动测试永不自动开浏览器窗。

> 前置(一次性):安装随包分发的 **GoTry Session Bridge** 浏览器扩展(MV3,约 30 秒):跑 `npx gotry setup` 落位到 `~/.gotry/extension`(推荐 `--extension-from=github` 走 GitHub Releases 下载通道;手动下载: Releases 标签 `ext-*`),再到 Chrome `chrome://extensions` 开启「开发者模式」→「加载已解压的扩展程序」选该目录。装完**零系统弹窗**——扩展只被动转发站点自己发出的检索响应(构造上只读;cookie 只读名字,值永不离开浏览器)。未安装时工具返回 `needs-extension` 并给出指引,不消耗执行配额。(诊断后备:cdp 车道经 `chrome://inspect` 远程调试,`GOTRY_SESSION_TRANSPORT=cdp` 显式开启——注意 Chrome 144+ 每次连接都会弹权限框。)

---

## 🏛️ 架构 — Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ L1  对话即界面  chat-as-UI; gates 是消息内选择题                 │
│ L2  编排  dsh 运行时 + GoTry 插件(ReAct);21 个工具            │
│ L3  领域  统一行程模型 + Z3 可行性引擎(枚举/Z3 双形态)        │
│ L4  数据  静态数据包 + hotelbyte-cli 实时桥 + OpenFlights 骨架 │
│ L5  治理  LoopX(objective / gates / evidence / quota)         │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 模块 | 角色 |
|---|---|---|
| L2 | `ts/src/index.ts`(dsh 插件) | 注册 21 工具,挂时间锚点/记忆 brief 变量;execute 异常隔离 + 授权闸 + 进程护栏 |
| L3 | `ts/src/unified.ts` · `py/gotry_feasibility/` | 唯一求解入口(候选枚举 + 航班链 Z3) |
| L4 | `ts/capabilities/effect.ts` · `hbcli.ts` · `skeleton-check.ts` | 效应解译层(退避重试/断路器/mock 解译器,issue #16)+ 实时库存桥 + OpenFlights 骨架(三值语义) |
| L5 | loopx 治理面 | objective / gates / evidence / quota |

> 📖 完整 ADR / 演进 / 债务清单: [`docs/architecture.md`](docs/architecture.md)

---

## ⚠️ 状态与限制 — Status & limitations

**今天可用的能力**(全栈回归 §1–§34 全绿,每项都有确定性测试):

- **Z3 求解引擎** —— 可行性判定 + 门到门全成本;历史并发竞态已根治(§30 并发回归闸)
- **实时检索**:机票/火车/酒店(飞猪官方通道)、目的地/酒店目录、天气、航班观测、通航性校验;可选让实时票价覆写进求解(`GOTRY_REALTIME_PRICING=1`)
- **账号会话检索**:你本人登录态查携程机票,授权与隐私规则见上方 **🔐 账号会话:授权与隐私** 小节
- **一次性浏览器扩展安装**:`npx gotry setup wizard` 引导你 30 秒装好 GoTry Session Bridge(MV3,扩展 ID 跨机器稳定,会话内零系统弹窗);后台 health-watch 探活,扩展一就位自动重放你的检索,**无需你手动重跑命令**
- **扩展分发双通道(issue #21,ADR-21)**:默认仍用包内副本(离线确定性);`npx gotry setup --extension-from=github` 显式走 GitHub Releases 下载通道(版本化 tar.gz + SHA256 + 固定 key 钉扎,原子交换 `~/.gotry/extension`,任何失败显式降级包内副本)。平台约束(诚实):Chrome 只有上架 Web Store 才能消掉「开发者模式加载已解压」的点击——上架材料已备好(`docs/extension-webstore-submission.md`,待 founder 提交)。
- **会话数据交叉验证(issue #21)**:8 条 sf-01..sf-08 benchmark query 端到端验证 —— 7/8 verdict=hit / 6/6 manual-golden 软命中 100% / hit 全部 <15s / ReadGuard 零写。可插拨 official golden(默认 manual-golden 公开班期 + 价格带,`--golden=flyai` 切换),**不绑任何 vendor**
- **记忆与触达**:动机画像 / 愿望池 / 同行人 / 旅行时间线;英文输出一键切换(`GOTRY_LOCALE=en`)

**已知限制**(截至 2026-08-29,诚实清单):

- ⏳ **M3 Exit 未关闭** —— 工程与分发面就绪,但"真实种子用户"证据(50–200 人 cohort)尚未积累;自动化测试证明的是合同与公式,不是 business pass
- ⏳ **携程酒店 / 美团的登录态会话适配** —— 机票已通,酒店面等登录态实测回填(下一个 tick)
- ⏳ **界面语言** —— 英文界面仅覆盖求解确定性输出层;dsh 宿主界面与对话面属宿主/校准件

<details>
<summary>📖 更深的工程状态(账本合同 / 证据合同 / 里程碑口径)</summary>

状态权威面在这里,README 不展开:事务化状态账本(ADR-15)+ 双形态冻结(ADR-16:本地+Web 一套账本语义);M3 真实 cohort 证据合同已立(fixture 不充当 Exit,真实 50–200 人样本即开 Exit);M4 paired-cohort 价值证据合同(run-all §34)合成数据不充当 Exit 证据;异步工单终态合同(`gotry_async_terminal.v1`:4/4→succeeded/ledger settled/exit 0)。细则见 [`docs/roadmap.md`](docs/roadmap.md) / [`docs/architecture.md`](docs/architecture.md) §1 与 #19–#22。

</details>

---

## 📚 文档 — Docs

| 文档 | 适合谁 |
|---|---|
| [本 README](README.md) | **所有人**:是什么 · 怎么用 · 限制 |
| [`docs/architecture.md`](docs/architecture.md) | 工程师:分层 · ADR · 演进 · 债务 |
| [`docs/roadmap.md`](docs/roadmap.md) | 项目管理:M0–M6 与当前位置 |
| [`docs/user-guide.md`](docs/user-guide.md) | 终端用户:详细使用文档 |
| [`docs/gotry-product-design.md`](docs/gotry-product-design.md) | 产品:主循环 · 透明机制 · 全成本模型 |
| [`docs/gotry-master-outline.md`](docs/gotry-master-outline.md) | 决策者:工作分解 · 复用矩阵 |
| [`docs/kimi-postmortem.md`](docs/kimi-postmortem.md) | 所有人:真实 AI 旅行规划失败复盘(反面教材) |
| [`docs/release-notes.md`](docs/release-notes.md) | 历史:每个 tag 的发布闸勾稽 |

---

## 🧪 跑测试 — Verify

```bash
./scripts/run-all-tests.sh
```

全栈一次性绿(纯 TS,无 Python 依赖):engine/journey/unified 金标准 · 对话重放 · 异步工单跨进程 · 插件 smoke · hbcli · 进程护栏(含工具异常隔离)· 天气 · 航班 · Anything · probePoi · agent-reach(web/deep/wrapper)· 双路径稳定性 · 时间感评测(锚点卡/槽位过期校验/评分器/mock 回放;真模型巡检 `time-eval-tests.ts --real`)· 记忆域(动机合并守门/效用 sidecar/只读指标投影)· **Z3 并发竞态(§30)· 实时票价桥(§31)· i18n 目录(§32)· M3 cohort 证据合同(§33)· M4 价值证据合同(§34)· 会话传输扩展桥(§38)· onboarding UX wizard(§40)· 可下单事实闸(§39)· sf-live-benchmark 可插拨 golden(`ts/scripts/sf-live-benchmark.ts`,真跑 runner)· 扩展分发通道(§43)**。

---

## 🤝 参与开发 — Contributing

> *PR-based flow: branch off the latest `main`, full suite green, open a Pull Request — `main` never takes direct pushes; merge after review. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).*

标准开源流程:**`main` 不直接推**——从最新 `main` 切出 `feat/ · fix/ · docs/ · chore/` 分支,本地全栈绿后开 Pull Request,CI(Node 22/24,typecheck + 全部套件)与维护者 review 双绿后 squash 合入。**测试红着不许合。**

- 完整贡献指南(环境搭建 · 测试 · 分支与提交约定 · PR 流程): **[CONTRIBUTING.md](CONTRIBUTING.md)**
- Bug / 功能建议:[issue 模板](.github/ISSUE_TEMPLATE/bug_report.yml)(搜过既有 issue 再提)
- 行为或架构改动先立 ADR(`docs/architecture.md` §8);多 agent 协作契约见 [`AGENTS.md`](AGENTS.md)

---

## 📜 License

**MIT**(2026-08-23 落定)。与上游 dsh(MIT)/ loopx 一致——宽松、可商用、可闭源分叉。文本见 [LICENSE](LICENSE)。

---

## 🌐 中英版 — Locales

- 本文件(main)**英文版独立成文**:[README.md](README.md)——两文件各自完整,常见开源双语布局。
- 深 README(中文)面向中国出境首发种子用户群;英文版是它的完整镜像(不含深度工程文档)。
- `docs/` 深度工程文档当前中文先行,英文版计划 v0.1.0 同步。

---

**Built with**: DeepSeek Harness 0.1.2-alpha.1 (vendored) · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 (`.venv/`) · OpenFlights · TypeScript

**Last verified against `v0.0.1-rc.16`(2026-08-30)** — 全栈回归全绿 §1-§42(发布流程见 `scripts/publish-npm.sh`)。