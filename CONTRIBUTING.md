# 参与开发 — Contributing

> *How to set up, branch, test, and submit changes. `main` never takes direct pushes — every change lands as a reviewed Pull Request with the full suite green.*

欢迎参与 GoTry！GoTry 是「从出发到下一次出发」的 AI 旅行 Agent——先用**数学求解器**回答「能不能、怎么去、真实成本多少」，而不是让模型猜。本文是唯一权威的贡献指南；快速上手见 [README](README.md)，技术权威面见 [`docs/architecture.md`](docs/architecture.md)。

---

## 🧭 从零搭环境 — Setup

**环境前置**:

- **Node 22+**（`nvm install 22` 或更高;`package.json` engines 硬约束）
- **npm**（root 与 `ts/` 均用 npm,`package-lock.json` 锁定公共 registry 版本）
- **pnpm**（仅 vendored dsh runtime 一次性安装用）
- 可选:LLM API key(真模型巡检用;全部自动化测试均为 mock,不需要 key)
- 可选:Python `.venv`（agent-reach wrapper;缺失时测试自动降级为 needs-setup 断言）

```bash
git clone https://github.com/Danceiny/gotry
cd gotry

# ① 装 vendored dsh runtime(一次性;只影响 ./gotry web 产品形态,测试不依赖)
cd ts/dsh-runtime && pnpm install && cd ../..

# ② 装依赖(root = 产品面,ts = 插件/测试面)
npm ci
cd ts && npm ci && cd ../..

# ③ 配环境变量
cp .env.example .env      # 填 LLM_API_KEY(DeepSeek sk-... 或 OpenAI 兼容协议)
```

> **为什么是两份依赖**:root `package.json` 是 npm 包形态（`@danceiny/gotry`）的发布清单，`ts/package.json` 是插件源码与全部测试套件的开发清单。dsh runtime 是 vendored 且**不入 git**（`ts/dsh-runtime/` 内仅 `package.json`/lockfile 入库，`node_modules/` 与运行时 `gotry-state/` 被忽略），避免 npm 一键分发时整包打入。

---

## 🧪 本地验证 — Verify before you push

**提交前必跑，全绿才算完成**:

```bash
./scripts/run-all-tests.sh   # 全栈回归:§1-§32,含金标准/重放/账本/Z3 竞态/i18n 等全部套件
```

部分会打免费公网 API（Open-Meteo/OpenSky/FlyAI）——离线或被限流时对应套件有降级断言，不会无脑失败。会话面 live 嗅探默认可用 `GOTRY_SESSION_LIVE=0` 关闭。

单独跑某个套件:

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

- **`main` 是唯一长期分支**，受保护：不直接推，一切改动走 Pull Request。没有 dev/staging。
- 从最新 `main` 切出 topic 分支，**一个分支只做一件事**，命名：`feat/` · `fix/` · `docs/` · `chore/`。

```bash
git checkout main && git pull && git checkout -b fix/your-topic
```

提交约定（Conventional Commits,描述用中文）:

- 格式 `type(scope): 一句话说清「为什么」`，如 `fix(D-17): Z3 WASM race 根治——单一实例+会话级互斥`。
- **提交信息重点是动机**：为什么改，而不是改了什么（diff 自己会说话）。
- **只暂存你负责的具名文件**：禁止 `git add -A` / `git commit -am` 席卷工作区——并行开发时工作区常混有他人在制品。
- **测试红着不许合**：本地 `run-all-tests.sh` 全绿是开 PR 的前置条件。

---

## 🔀 Pull Request 流程 — PR Workflow

1. 本地全栈绿（§1-§32 全部通过）。
2. 推分支、开 PR：描述写清「**为什么改 · 改了什么 · 测试证据**」（模板已内置）。
3. CI 必须绿（typecheck + 全栈回归，Node 22/24 双版本），维护者 review 通过。
4. **squash 合入** `main`（保持线性历史），合入即删分支。

---

## 🐛 Issue 指南 — Issues

- **提 issue 前先搜既有 issue**，避免重复。
- **Bug**：用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml)——复现步骤 / 期望 / 实际 / Node 版本 / 相关证据链（GoTry 输出带 `[来源标注]` 的行最有价值）。
- **功能建议**：用 [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.yml)——说清**用户场景**与「透明机制」的关系（决策应可验证，不做黑盒）。
- 环境类问题先自查：`./gotry doctor` 输出、Node 版本、`.env` 是否就位。

---

## 🏛️ 代码纪律 — Engineering rules

这些是硬约束（详见 [`AGENTS.md`](AGENTS.md) 与 [`docs/architecture.md`](docs/architecture.md)）：

- **分层纪律**:算术只在 `model.ts`/`unified.py` 的 evaluate 层；求解只在 `unified.ts`/`unified.py`；`engine.*`/`journey.*` 是 deprecated 兼容层，**新代码不得调用**。
- **TS↔Python 无桥**:`py/gotry_feasibility` 仅作历史对照 oracle，产品运行时与工具链零引用；**不得新增任何 Python 依赖面**。
- **红线进代码**:动机画像无 evidence 拒绝落盘；wish pool 条目强制 conditions；写操作（预订/支付类工具）必须过 WriteGate（确认前不得实现任何直接写）。
- **行为或架构改动先立 ADR**（`architecture.md` §8,三个诞生渠道：失败/对账/里程碑复审）。
- **状态面同步**:任何改变系统当前形态/状态/债务的提交，必须在**同一提交**内同步 `architecture.md` §11 列出的 6 处状态面。
- **数据红线**:巡检/测试**不得写入共享运行时状态**（创始人真实数据在 `ts/dsh-runtime/gotry-state/`）——验证写路径一律用隔离 `stateRoot`。

---

## 🚢 发布 — Release

发布是 founder 确认制（发不发、发哪个版本由 founder 确认；确认后打 tag / 推 remote / npm 发布由执行者完成）。贡献者无需关心；发布闸五条与 registry 回拉验证见 [`AGENTS.md`](AGENTS.md) 与 [`docs/release-notes.md`](docs/release-notes.md)。

---

## 📜 License

MIT。提交即表示同意以 **MIT** 授权你的贡献，与仓库许可一致。