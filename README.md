# GoTry

> **身体和灵魂，更多旅行，更少旅游。**
> *Body and soul — more travel, less tourism.*

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**：你用一句话说想去哪、为什么想出发；它先问清楚你的工作时间和已订资源，再用**数学求解器**给你一份经过验证的行程方案。

**GoTry is an AI travel agent for departure-to-next-departure.** Tell it where you want to go and why. It asks what's missing, then hands you a **formally verified itinerary** — not vibes.

| | |
|---|---|
| **Version** | `v0.0.1-rc.7`(npm: `@danceiny/gotry@rc`;[release notes](docs/release-notes.md)) |
| **Status** | M3 工程面 + npm 公开分发就绪;16 套测试全绿 |
| **Repo** | [github.com/Danceiny/gotry](https://github.com/Danceiny/gotry) (private) |
| **Runtime** | DeepSeek Harness 0.1.1-rc.2 (vendored `ts/dsh-runtime/`, [upstream](https://github.com/deepseek-ai/DeepSeek-Harness)) · Z3 (npm `z3-solver`) · LoopX (pipx, `~/.local/pipx/venvs/loopx/bin/loopx`) · Agent-Reach v1.5.0 (`.venv/bin/agent-reach`) |
| **License** | **MIT** (2026-08-23 落定,见 [LICENSE](LICENSE)) |


---

## ✨ 它做什么 — What it does

GoTry 把「想去哪」变成「能不能、怎么去」：

| 阶段 | AI/Engine | 输什么 |
|---|---|---|
| **动机访谈** | LLM | 必问项：工作窗口 / 已订资源 / 出发城市 |
| **事实抽取** | LLM | 工作窗口生效 + 休假语义识别 |
| **可行性判定** | **Z3** | 哪些候选目的地**可行**、哪些**不可行**、为什么、**如何最小化改动让它变可行** |
| **门到门全成本** | 求解器 | 真实飞行时长（含时差）+ 醒来起夜惩罚 + 接驳代价 + 到达精力 % |
| **证据链** | 渲染层 | 每个数字标 `[骨架:openflights]`、`[实时API:hbcli]`、`[静态包:估算]` |

**不像普通 AI 聊天**——LLM 只做理解和解释，**判定与算术是数学求解器**算的。

> **Unlike a regular AI chat**, the LLM only translates and explains. **Decisions and arithmetic are computed by a Z3 solver**, not guessed.

---

## 🚀 快速开始 — Quick start

### 一行启动(npm,推荐)

```bash
npx @danceiny/gotry@rc web          # 首跑会提示在当前目录建 .env(LLM_API_KEY=<DeepSeek key>)
```

装完即得 :3080 对话界面。已装 dsh 的用户同理——上面的命令会自动以 cordis patch
挂载 gotry 插件,无需任何额外配置(零成本启动)。

### 源码安装(开发者)

```bash
git clone https://github.com/Danceiny/gotry
cd gotry
```

#### A. 装 vendored dsh runtime(一次性,约 1 分钟)

```bash
cd ts/dsh-runtime
pnpm install    # 拉 @deepseek-ai/dsh 0.1.1-rc.2 + 依赖(实测 51 秒)
cd ../..
```

> 为什么这一步:dsh runtime 是 vendored 的(`ts/dsh-runtime/`)——
> 避免 npm 一键分发时把整个 dsh 也打包进去。
> 之后可以重复使用,无需重装。

#### B. 环境前置 — Prerequisites

- **Node 22+**(`nvm install 22` 或更高)
- 一个 LLM API key(默认走 DeepSeek,也支持 OpenAI 兼容协议)

#### C. 配 — Configure

```bash
cp .env.example .env
# 填 LLM_API_KEY(deepseek: sk-...; 也兼容 OpenAI/Anthropic 兼容协议)
```

#### D. 跑 — Run(仓内入口,开发者)

gotry 把 **DeepSeek Harness (dsh) 运行时**作为唯一推荐面——任何自然语言输入在那里面都能跟 GoTry 正常对话(自动调用引擎、追问缺失字段、给出证据链)。

启动方式有三种,对应三种使用场景:

| 入口 | 命令 | 什么时候用 | 给你什么 |
|---|---|---|---|
| **① dsh Web 对话框**(推荐) | `./gotry web` | 第一天上手;持续多轮规划;想看推理过程可视化 | `http://127.0.0.1:3080` 浏览器界面;带 GoTry 人格的对话框 |
| **② headless 一次性问答** | `./gotry "一句完整任务..."` | 写脚本、CI 自动化、定向 LLM 调试 | stdout 输出 markdown 回答 |
| **③ help** | `./gotry help` | 不知道用法 | 三行帮助 |

```bash
# 推荐:打开对话框,正常打「我想去大理三天」,看引擎回答
./gotry web
#   → http://127.0.0.1:3080,在输入框里像跟 DeepSeek 对话一样打字

# 调试/自动化:直接一问一答,无浏览器
./gotry "我想从深圳休整两天,预算 3000"
#   → stdout 拿到引擎判定 + 证据链 + 候选 gate

# 不知道用法
./gotry help
```

> ⚠️ **dsh 运行时端口冲突**:如果你之前已经手动 `node ...dsh web` 跑过,而后再 `./gotry web`,会因 `:3080` 占用启动失败。要么先 `kill <PID>`,要么直接用已经在跑的那个。
>
> **dsh 启动耗时**:第一次 cold start 6–15 秒(cordis 组合 + plugin 加载 + LLM 准备);之后热启动 < 2 秒。
>
> **headless 报错兜底**:意外退出(exit ≠ 0 / signal)会 fsync 一条记录到 `gotry-state/incidents.jsonl`,作为事故证据而不是沉默(D-NEW 进程护栏)。

<br>

*One-liner mental model: `npx @danceiny/gotry@rc web` + `.env` 一行 key — done。dsh 对话框是唯一产品面(旧 shell 前端已删除)。*

> 一行安装的关键点: `./gotry web`(终端粘贴即用),或 `./gotry "任务"`(一句问答)。**任何自然语言都能用**(这是 dsh runtime 投资的最大价值)。详见 [known limitations](#-known-limitations)。


---

## 🎬 一段对话 — Demo

输入 → 引擎判定 → 输出（真实截图，monospace 保留原味）：

```
> 我想去洱海边发呆两三天，上海出发，预算 3000，年假别让我办公。

GoTry: 收到。先把约束记下来——
  • 窗口: 2 天(2026 年窗口)
  • 出发: 上海
  • 预算: ¥3000 全含
  • 动机: 休整 / [escape_rest: 0.7]
  • 不要求工作窗口(年假)
  • 还没订任何东西

引擎判定:

  **大理·洱海: 现在不行** —— 冲突约束: duration。
    你的 2 天窗口装不下「至少 5 天的洱海休整」(你之前的画像也有此约)。
    放宽方案: 把行程延长到 5 天,约 ¥4950。
  ★已放入「下一次出发」清单: 需 5 天起,3-5 / 9-11 月最佳。

  **千岛湖: 可行** (G7315 06:35 出发,bus 接驳,
   ¥996,起床 06:35,到达精力 84%,门到门 5h20m,
   有效休整 4.4h)
  **太湖: 可行** (G101 09:00 出发,
   ¥716,起床 07:12,到达精力 84%,
   有效休整 4.6h)

  建议: 千岛湖(意象匹配 80%)。
  备选: 太湖(¥716,匹配 60%)。

**待你决定**:
  1. 千岛湖还是太湖?(前者更贴意象,后者更省)
  2. 出发班次选 G7315(06:35)还是更晚的?

[骨架:openflights] ✓ SZX↔PVG 已校验 [实时API:hbcli] 上海机场在跑
[静态包:估算] G7315/G7316 价格按 7-8 月淡季估算
```

> **Brief English summary**: input → engine verdicts (feasibility + whole-cost) → recommendation + wish-pool entry for infeasible candidates. Every numeric carries an evidence tag.

---

## 🏛️ 架构 — Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ L1  对话即界面  chat-as-UI; gates 是消息内选择题                 │
│ L2  编排  dsh 运行时 + GoTry 插件(ReAct);12 个工具            │
│ L3  领域  统一行程模型 + Z3 可行性引擎(枚举/Z3 双形态)        │
│ L4  数据  静态数据包 + hotelbyte-cli 实时桥 + OpenFlights 骨架 │
│ L5  治理  LoopX(objective / gates / evidence / quota)         │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 模块 | 角色 |
|---|---|---|
| L2 | `ts/src/index.ts` (dsh 插件) | 注册 12 个工具,挂 `{{current_date}}` 时间感知变量,工具 execute 异常隔离 + uncaughtException 护栏 |
| L3 | `ts/src/unified.ts` · `py/gotry_feasibility/unified.py` | 唯一求解入口(候选枚举 + 航班链 Z3) |
| L4 | `ts/capabilities/hbcli.ts` | hotelbyte-cli 进程封装 + 降级到 `data/hotels_2026.json` |
| L4 | `ts/scripts/skeleton-check.ts` | OpenFlights 168 对枢纽,三值语义(阳性/枢纽对否定≠证伪/枢纽外=无结论) |

> 📖 完整 ADR / 演进阶段 / 债务清单见 [`docs/architecture.md`](docs/architecture.md)。


---

## ⚠️ Known limitations · 已知限制

- ✅ **License MIT** (D-1 落地 2026-08-23)
- **zh-CN 体验** — 当前面向中国出境首发(你的账号语言习惯)。英文界面/wider 国际化未做,等 M4 校准输入落定。
- **机票实时数据** — 静态包(`data/flights_2026.json`)作为降级。实时票价接入留到 v0.1.x。
- **Z3 WASM race** — 连续跑多个测试套件时偶发 `memory access out of bounds`(已规避回滚)。M3 早期处理。
- **薄壳已废弃** — `./gotry shell` 不再推荐;dsh web 是唯一面。本版 README 仍保留旧命令行做迁移证据。


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

16 套测试,一次性绿(纯 TS,无 Python 依赖):engine/journey/unified 金标准 · 对话重放 ·
异步工单跨进程 · 插件 smoke · hbcli · 进程护栏(含工具异常隔离) · 天气 · 航班 ·
Anything · probePoi · agent-reach(web/deep/wrapper)· 双路径稳定性。

---

## 🤝 参与开发 — Contributing

仓库内 branch 模型:`main` 是唯一分支(没有 dev/staging)。所有迭代在 main 直接推(每次提交需全栈绿)。

```bash
./scripts/run-all-tests.sh   # 提交前必跑

# 单独跑某个套件
cd ts && npx tsx scripts/replay.ts          # 对话重放(mock,不需要 key)
cd ts && npx tsx scripts/hbcli-tests.ts     # 能力封装
cd ts && npx tsx scripts/incident-tests.ts  # 进程护栏
```

ADR 与技术债见 [`docs/architecture.md` §8 / §10](docs/architecture.md)。Agent 协作契约见 [`AGENTS.md`](AGENTS.md)。

---

## 📜 License

**MIT**（2026-08-23 落定）。与上游 dsh（MIT）/ loopx 一致——宽松、可商用、可闭源分叉。

文本见 [LICENSE](LICENSE)。

---

## 🌐 中英版 — Locales

- **English section summaries** are inline above (italic blockquotes).
- 本 README 主语言是中文,面向中国出境首发种子用户群。
- 完整英文版 README 计划在 v0.1.0 同步([issue 路线](#-known-limitations))。

---

**Built with**: DeepSeek Harness 0.1.1-rc.2 · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 (`.venv/`) · OpenFlights · TypeScript · Bun

**Last verified against `v0.0.1-rc.7`** — 16/16 suites green(发布流程见 `scripts/publish-npm.sh`,内部决策见 [docs/decisions-needed.md](docs/decisions-needed.md)、[docs/tokens.md](docs/tokens.md))。
