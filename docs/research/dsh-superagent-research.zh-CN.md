[English](dsh-superagent-research.md) | [简体中文](dsh-superagent-research.zh-CN.md)

# dsh-superagent 技术路线研究 → gotry 采用边界与落地路径（issue #696）

> 状态：frozen（研究底稿，2026-11-17；采用进度归 [issue #696](https://github.com/Danceiny/gotry/issues/696)）
> 对象：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT；官方标注研究原型；单 commit；~23.6k stars）
> 背景：创始人 2026-11-17 拍板「dsh 的 super agent 技术路线非常合适，跟进」。
> 来源纪律：一手 = 仓库本体（README、SETUP、docs/000–008；本文以 docs/007-architecture 与 docs/003-execution 全文为准）；二手（新闻报道与配套论文）仅标注不采信。

## 结论（先读这里）

1. **路线本质**：在 dsh 宿主内跑「路由者 + 工作者」双角色编排器。Source（GitHub/飞书）产出 Trigger → Intake 去重入账 → Eval 由主会话评估候选 → Decision（accept/stop/ignore/unavailable）→ accept 生成 Ticket（携带 Mandate 授权基）→ Assignment 每 Ticket 一个隔离 dsh 会话 + 独立目录 → worker 以 Report（waiting/ready/blocked/failed/dropped）回报 → Outbox 有序回帖到原会话。持久层单 SQLite、每状态单写者、事务内入队 afterCommit 执行的 effect 队列、outbox 回执。
2. **gotry 采用两个面**：面一（先落地）＝gotry 仓库自身开发流程——AGENTS.md 的 async 工单清扫 + LoopX tick 本就是手搓版 Trigger→Ticket→Assignment 循环；面二（参考面）＝AaaS（#674）——单写者/持久 effects/outbox/policy gate 与 A1 状态层、A2 身份配额同构，吸收设计不搬代码。
3. **硬先决**：superagent `engines: dsh ^0.2.1-alpha.2`（peer 全家族 ^0.2.1-alpha.2、cordis 4.0.5-alpha.1、schemastery 3.18.5-alpha.1）；gotry main 现锁 `@deepseek-ai/dsh 0.2.0-rc.2`。**不升级不部署**（#696 P1 闸）。founder 2026-11-17 追加拍板：gotry 是实验性项目，**dsh 永远跟最新**——P1 直接升到最新线（0.2.2-rc.3），不为迁就 superagent 的 0.2.1 线 peer 而降速；superagent 侧 peer 差异留到 P2 部署时以其自身升级或 engine 放宽解决。
4. **成熟度边界**：官方声明研究原型、非生产件、与内部版/论文有差异；无记录清理（trigger/disposition/decision/outbox 无限增长）；目录 wrapper「是默认值不是安全边界」，worker 以操作者 OS 用户无审批跑命令。采用＝先 pilot 后 adapt，直接产品化被拒。

## 1. 路线是什么

**五阶段管线**（Engine 五个单向依赖部件）：Intake（Trigger 入账/去重/扇出）→ Evals（候选评估、超时重排、三次过期记 unavailable）→ Tickets（生命周期、Mandate、订阅 Thread）→ Assignments（执行事实与 worker 报告）→ Replies（ack/answer/result/attention 四类出站消息）。

**双角色**：主会话（`dsh-superagent-router` preset，14 个 orchestrator_* 工具，5 秒 shell/等待上限——路由者不干活）＋ 每 Ticket 一个 Executor 会话（`dsh-superagent-worker` preset，6 个工具，前台命令 5 秒转后台 job，30 分钟后台限时，worker slots 并发闸 + 1 个人类唤醒加急槽）。

**授权模型**：Policy gate 按 Trigger 来源定准入强度，Mandate 记录准入基（addressed/followup/admission/bot 四类），策略版本化并在变更时重验在途 Ticket；「仅在被人要求或团队规则允许时行动」。主动候选默认只出「would accept」记录，auto 模式 + 显式规则才可自动接受。

**恢复模型**：先存后做（effect 入队于事务内、提交后执行）；重启后中断的 Assignment 带 recovery note 续跑（最老 Ticket 优先）；消息已读以「进入会话历史 + 其后有 Report 或回合结束」为准；outbox 保证同 Ticket 同会话有序投递、三连败升级为系统问题。

## 2. 为什么适合 gotry

- **同根**：同为 dsh/cordis 插件 bundle（cordis.patch.yml 三插件形态与 gotry 打包方式一致），无跨宿主桥接成本；gotry 的 dsh 依赖树里 subagent/jobs/schedule/webhook 基建全部现成。
- **同题**：gotry 仓库现在靠纪律维持的「每 tick 全量核查 open issues、async 工单一小时回捞、并行 lane 独立 worktree」，正是这条路线把 Intake→Eval→Ticket→Assignment 机制化的对象；「跑测必须有正式总结」「commit 前查分支」这类 founder 纪律可沉进 worker preset/prompt。
- **同构**（面二）：AaaS A1 要的 claim/CAS/fencing 对应其单写者 + 目录锁 + 事务 effect；A2 的鉴权/配额对应 Policy gate + Mandate 重验 + worker slots。见 §4 映射表。

## 3. 面一：本仓库 pilot（P2–P3）

- **部署形态**：独立机器 profile + 隔离 `stateRoot`（State Discipline 红线：不碰 `ts/gotry-state/` 创始人真实数据）；监听本仓库 issue/PR；agent 账号由创始人授权（仓库现无可写 bot 账号）。
- **P2 只读闸**：只评估（Eval 面板出候选卡）不执行（不开 Assignment），验证授权表、策略版、面板注意力流真实可用；退出证据＝founder 评审运行记录。
- **P3 执行闸**：白名单 Mandate 下执行真实工单（prepare 用 `git worktree` 起隔离检出——与 worktree isolation mandate 同构）；对照 LoopX 流程评估采用/放弃。
- **明确不启用**：auto-merge（其默认规则允许 <200 行 PR 自动合并——gotry 发布纪律要求创始人确认，不合）；auto 模式主动接受（保持「仅在被人要求时行动」）。

## 4. 面二：AaaS（#674）参考映射

| superagent 机制 | AaaS 对应 | 吸收方式 |
|---|---|---|
| 单写者 SQLite + 目录锁 | A1 keyed per-tenant 单写者 | 设计参考（RFC 对比项之一） |
| 事务内入队、afterCommit 执行的 effect 队列 | A1 持久任务/恢复语义 | 设计参考 |
| Outbox 回执（有序、退避、三连败升级、dropped 留痕） | A1/A3 消息可靠性 | 设计参考 |
| Policy gate + Mandate 基 + 版本化重验 | A2 principal/鉴权/配额 | 概念对齐 |
| worker slots + 人类唤醒加急槽 | A3 并发/扩容 | 设计参考 |

复用矩阵口径：MIT 开源可导入；但「研究原型、adapt before use」——AaaS 只吸收模式，不引入该包为运行时依赖。

## 5. 风险与先决

| 项 | 事实 | 对策 |
|---|---|---|
| dsh 版本闸 | superagent 需 ≥0.2.1-alpha.2，main 锁 0.2.0-rc.2；founder 拍板永远跟最新 | #696 P1：全家族直接升最新（0.2.0-rc.2 → 0.2.2-rc.3）+ 全栈回归（0.1.5→0.2.0 的契约面清单在 PR #610 可复用） |
| 安全边界 | wrapper/目录是默认值非安全边界；worker 以操作者 OS 用户无审批执行 | pilot 机器最小化、独立 OS 用户、只读凭据先行 |
| 无限增长 | 无记录清理 | pilot 定期重建 stateRoot；引入前补 retention |
| 与论文/内部版差异 | 官方声明 published code ≠ 内部版 | 只以仓库本体为一手来源 |
| 单 commit 无历史 | 无法追上游修复节奏 | 锁定 commit SHA，升级走重评估 |

## 6. 明确不采用

- **不进产品运行时**：gotry 产品是旅行 agent，不是编排器；superagent 与 booking/支付路径零关系。
- **不搬 Feishu 源**：gotry 开发流在 GitHub；飞书源不入第一版。
- **不搬管理面板为产品 UI**：panel 仅 pilot 运维用。

## 7. 落地顺序

P0 本文（#696）→ P1 dsh 升级闸（独立 PR）→ P2 只读 pilot → P3 执行试点 + 采用决策。每阶段退出闸见 #696 阶段表。

---

来源（一手）：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) · `docs/007-architecture.md` · `docs/003-execution.md` · `SETUP.md` · `package.json`（engines/peers）
二手（仅背景，不采信为机制依据）：Help Net Security 2026-11-02 报道 · 配套论文 *Exploring Super-agent Design: Towards a More Autonomous Agent System*（未读全文）
