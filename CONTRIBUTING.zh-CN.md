[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# 参与开发 — Contributing

> *How to set up, branch, test, and submit changes. Project rule: `main` is updated through reviewed Pull Requests with local final-SHA evidence plus CI signal.*

欢迎参与 GoTry！GoTry 是「从出发到下一次出发」的 AI 旅行 Agent——先用**数学求解器**回答「能不能、怎么去、真实成本多少」，而不是让模型猜。本文是唯一权威的贡献指南；快速上手见 [README](README.zh-CN.md)，技术权威面见 [`docs/architecture.md`](docs/architecture.zh-CN.md)。

---

## 🧭 从零搭环境 — Setup

**环境前置**：

- **Node 22.15+**（`nvm install 22` 或更高；`package.json` engines 硬约束）
- **npm**（root 与 `ts/` 均用 npm，`package-lock.json` 锁定公共 registry 版本）
- **pnpm**（仅维护 legacy vendored dsh runtime 时需要；普通源码开发不需要）
- 可选：LLM API key（真模型巡检用；全部自动化测试均为 mock，不需要 key）
- 可选：Python `.venv`（agent-reach wrapper；缺失时测试自动降级为 needs-setup 断言）

```bash
git clone https://github.com/Danceiny/gotry
cd gotry

# ① 装依赖
#    root 钉产品面与 DSH runtime 闭包;ts 用子壳跑(cd 不外溢,后续命令仍留在仓根)。
npm ci --strict-peer-deps
(cd ts && npm ci --strict-peer-deps)

# ② 构建源码检出的 JS runtime
node scripts/build-dist.mjs

# ③ 配环境变量
cp .env.example .env      # 填 LLM_API_KEY(DeepSeek sk-... 或 OpenAI 兼容协议)
```

> **为什么是两份依赖**：root `package.json` 是 npm 包形态（`@danceiny/gotry`）的发布清单，也把源码与发布形态共用的 230 个 DSH `0.1.5-alpha.1` runtime 包全部锁成精确直接依赖；manifest、package-lock 与 root pnpm importer 必须暴露同一 230 项名称集合，publish preverify 会拒绝漏钉、混版和 range。`ts/package.json` 是插件源码与全部测试套件的开发清单。源码普通运行的 dsh cwd 保持在 `ts/dsh-runtime/`，真实运行状态继续落 `ts/dsh-runtime/gotry-state/`；benchmark opt-in 与 npm 包运行使用调用目录隔离。`ts/dsh-runtime/vendor/` 的 legacy 目录仅作锁一致性证据保留，运行时只走 root 依赖闭包解析；`node_modules/` 与运行时 `gotry-state/` 仍被忽略。

---

## 🧪 本地验证 — Verify before you push

**提交前必跑；脚本输出的节号/套件清单是唯一权威，文档不写死 `§1–N` 计数**：

```bash
(cd ts && npx tsc --noEmit)
node scripts/build-dist-compat-tests.mjs        # 当前 Node 的 exact dist/ESM/import proof
GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh   # 末行必须含 ALL SUITES GREEN
```

每个 PR 描述都要贴**最终 SHA** 上的命令、exit code 和关键末行。CI 在 Node 22/24 跑 typecheck + 全栈回归，并在 Node 22/24/26 跑 focused dist 兼容闸；它只能补充本地证据，不能替代本地最终 SHA 复跑。

天气回归使用受控 deterministic fixture；真实 Open-Meteo/Nominatim 仅属可变外围观测，不决定 merge gate。OpenSky/FlyAI 等 live 通道离线或被限流时对应套件有降级断言；会话面 live 嗅探默认可用 `GOTRY_SESSION_LIVE=0` 关闭。HotelByte 供应商 UAT 不受该开关控制，默认离线且不探测本机 `hbcli` 或凭证。

HotelByte 离线回归（默认包含在全栈入口）：

```bash
GOTRY_HBCLI_LIVE=0 ./scripts/run-all-tests.sh
```

真实 UAT 只在明确授权的环境运行（会使用隔离临时凭证面并请求 HotelByte UAT，不属于默认回归）：

```bash
cd ts && GOTRY_HBCLI_LIVE=1 npx tsx scripts/hbcli-e2e-tests.ts
```

`GOTRY_HOTELBYTE_SKILLS_LIVE=1` 仅启用 §17 的远端 `hotelbyte-skills` 契约读取；未设置、`0` 或其他值只跑本地工具描述契约，不读取 GitHub keychain。`GOTRY_SESSION_LIVE` 不会打开 HotelByte UAT。

单独跑某个套件：

```bash
cd ts && npx tsx scripts/engine-tests.ts        # 金标准(§1)
cd ts && npx tsx scripts/replay.ts              # 对话重放(mock §4)
cd ts && npx tsx scripts/ledger-tests.ts        # 事务账本(§28)
cd ts && npx tsx scripts/z3-race-tests.ts       # Z3 并发竞态闸(§30)
cd ts && npx tsc --noEmit && npx tsx scripts/smoke.ts   # 类型 + 插件 smoke(升级后必跑)
```

真 LLM 巡检（`replay-real.ts` / `time-eval-tests.ts --real`，ADR-11 层）**消耗真实 key**，维护者在本地执行，不进 CI。

---

## 🌿 分支与提交 — Branch & Commit

- **`main` 是唯一长期分支**，项目协作规则要求一切改动走 Pull Request。没有 dev/staging。
- 从最新 `main` 切出 topic 分支，**一个分支只做一件事**，命名：`feat/` · `fix/` · `docs/` · `chore/`。

```bash
git checkout main && git pull && git checkout -b fix/your-topic
```

提交约定（Conventional Commits，描述用中文）：

- 格式 `type(scope): 一句话说清「为什么」`，如 `fix(D-17): Z3 WASM race 根治——单一实例+会话级互斥`。
- **提交信息重点是动机**：为什么改，而不是改了什么（diff 自己会说话）。
- **只暂存你负责的具名文件**：禁止 `git add -A` / `git commit -am` 席卷工作区——并行开发时工作区常混有他人在制品。
- **测试红着不许合**：本地最终 SHA 的 `run-all-tests.sh` 全绿是开 PR 的前置条件。

---

## 🔀 Pull Request 流程 — PR Workflow

1. 在最终 SHA 本地跑 `(cd ts && npx tsc --noEmit)` 与 `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh`，并记录 exit code 与 `ALL SUITES GREEN` 末行。
2. 行为、用户可见或业务效果变化必须补一条最小 E2E 证据；纯文档/索引改动要给路径/链接检查或说明 N/A 的 burden-of-proof。
3. 推分支、开 PR：描述写清「**为什么改 · 改了什么 · 最终 SHA 本地证据 · E2E 行 · N/A/跳过边界**」。
4. CI 的 Node 22/24 typecheck + 全栈回归与 Node 22/24/26 focused dist 兼容闸必须绿，但只作为补充信号；维护者 review 通过。
5. 合入方式与 head 守卫见 [`docs/ops/external-pr-workflow.md`](docs/ops/external-pr-workflow.md)：维护者选择仓库允许的合并方式、核对 exact head、并记录 destination SHA。

---

## 🐛 Issue 指南 — Issues

- **提 issue 前先搜既有 issue**，避免重复。
- **Bug**：用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml)——复现步骤 / 期望 / 实际 / Node 版本 / 相关证据链（GoTry 输出带 `[来源标注]` 的行最有价值）。
- **功能建议**：用 [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.yml)——说清**用户场景**与「透明机制」的关系（决策应可验证，不做黑盒）。
- 环境类问题先自查：`./gotry doctor` 输出、Node 版本、`.env` 是否就位。

---

## 🏛️ 代码纪律 — Engineering rules

这些是硬约束（详见 [`AGENTS.md`](AGENTS.zh-CN.md) 与 [`docs/architecture.md`](docs/architecture.zh-CN.md)）：

- **分层纪律**：算术只在 `model.ts`/`unified.py` 的 evaluate 层；求解只在 `unified.ts`/`unified.py`；`engine.*`/`journey.*` 是 deprecated 兼容层，**新代码不得调用**。
- **TS↔Python 无桥**：`py/gotry_feasibility` 仅作历史对照 oracle，产品运行时与工具链零引用；**不得新增任何 Python 依赖面**。
- **红线进代码**：动机画像无 evidence 拒绝落盘；wish pool 条目强制 conditions；写操作（预订/支付类工具）必须过 WriteGate（确认前不得实现任何直接写）。
- **行为或架构改动先立 ADR**（`architecture.md` §8，三个诞生渠道：失败/对账/里程碑复审）。
- **状态面同步**：任何改变系统当前形态/状态/债务的提交，必须在**同一提交**内同步 `architecture.md` §11 列出的 6 处状态面。
- **语义/架构/维护兼容**：语义变更要说明用户可见差异与最小 E2E；架构变更要说明 ADR/设计让渡；维护类改动要说明兼容面、回滚面与不改哪些文件。
- **数据红线**：巡检/测试**不得写入共享运行时状态**（创始人真实数据在 `ts/dsh-runtime/gotry-state/`）——验证写路径一律用隔离 `stateRoot`。

---

## 🚢 发布 — Release

发布是 founder 确认制（发不发、发哪个版本由 founder 确认；确认后打 tag / 推 remote / npm 发布由执行者完成）。贡献者无需关心；发布闸五条与 registry 回拉验证见 [`AGENTS.md`](AGENTS.zh-CN.md) 与 [`docs/release-notes.md`](docs/release-notes.zh-CN.md)。

---

## 📜 License

MIT。提交即表示同意以 **MIT** 授权你的贡献，与仓库许可一致。
