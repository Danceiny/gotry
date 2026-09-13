[English](README.md) | [简体中文](README.zh-CN.md)

# GoTry 文档规范与总索引

> 定位：本目录的**组织规范与唯一索引**——新文档放哪、怎么命名、头部怎么写、生命周期怎么走，以及全部文档的一行式索引。
> 上游：`AGENTS.md`（仓库契约）；状态面纪律见 `architecture.md` §11。
> 纪律：单一文件承载单一关注点，版本历史归 git，不设 vN 文件后缀。
> 双语：每篇文档 = 英文基座 `x.md` + 中文镜像 `x.zh-CN.md`，成对维护、同提交同步，**不一致视为 bug**。

---

## 1. 目录税则（按生命周期阶段分，不按主题分）

| 目录 | 角色 | 进入条件 | 离开条件 |
|---|---|---|---|
| `docs/` 根 | **现行权威面 + living 队列** | 创始人/契约确认为唯一权威面（如「唯一技术权威面」「唯一时间线」） | 权威让渡给他文档后移入对应子目录 |
| `design/` | 模块级设计文档（proposal/accepted/active） | 有上游 ADR/issue，描述某模块的词汇、不变量与判定 | 被权威面完全吸收后移 `milestones/` 或删除 |
| `rfc/` | 提案原文（待拍板或已采纳） | 需要创始人拍板的方案，文件名以 `-rfc` 结尾 | 采纳后状态改 `accepted` 留存；拒绝改 `rejected` 留存 |
| `research/` | 调研与复盘（冻结） | 时间戳敏感的调查、竞品研究、postmortem | 不离开；结论被采纳后正文吸收进权威面，原文冻结 |
| `milestones/` | 里程碑备忘（历史记录） | 某里程碑的阶段产出、走查、对账、决策备忘 | 不离开；里程碑关闭即冻结 |
| `evaluation/` | 评测体系（契约、台账、横评、验证记录） | 评测/benchmark/e2e/persona 横评相关材料 | 契约类可长期 living |
| `ops/` | 发布与合规运营材料 | 商店上架、隐私政策等对外合规文本 | 长期 living |
| `assets/` | 工具生成物（架构图、可视化产物） | archify 等工具输出 | 随工具重生成覆盖 |
| `superpowers/` | superpowers 工作流自有命名空间（plans/specs） | 由 superpowers 技能自动写入 | 工具自管，手工文档勿入 |

**决策规则**：先问「这篇文档的生命周期阶段是什么」，不问「它讲什么主题」。一篇 M5 的调研仍然进 `research/`，不进「m5/」。

## 2. 命名规范

- 一律 kebab-case 小写；禁止 `vN` 版本后缀（版本历史归 git）。
- **双语成对（loopx 约定）**：英文基座 `x.md` + 中文镜像 `x.zh-CN.md`；机器生成文档（如 `CHANGELOG.md`）与工具自管的 `superpowers/` 命名空间豁免。新文档落地即双语；改任何一侧必须同提交同步另一侧。机械校验：`node scripts/check-docs-i18n.mjs`（存在性 + 标题/代码块/链接数对等）。
- 八个读者入口文件——README、架构、路线图、冻结 Stage 1 设计的中英双语版本——还必须通过 `node scripts/check-doc-readability.mjs`：面向读者章节的校准行数／字节预算、逻辑行字节上限、双语对 parity、禁止修订史节、禁止追加式 issue/date 台账、权威面／冻结设计前言有界。
- 权威面：裸主题名（`architecture.md`、`roadmap.md`），不带任何前后缀。
- RFC：`<主题>-rfc.md`；设计：`<主题>-design.md` 或 `<角色>-guide.md`；调研：`<主题>-research.md`、复盘：`<主题>-postmortem.md`。
- 里程碑备忘：`<里程碑号>-<主题>.md`（如 `m3-web-gap.md`）；一次性计划/规格：`YYYY-MM-DD-<主题>.md`。
- 存量文件名不追改（历史前缀即纪年）；本规范约束新文档。

## 3. 通用头部块（所有文档必带）

```markdown
# <标题>

> 定位:一句话关注点(全仓唯一关注点,与他文档不重叠)
> 状态:living | proposal | accepted | rejected | frozen(YYYY-MM-DD)
> 上游:本文档服从的权威来源(ADR/总纲/契约)
> 下游:本文档的消费方(代码模块/其他文档/人)
```

字段按需增删（如 `读者`、`日期`、`信源纪律`），但 `定位` 与 `状态` 不可省。

## 4. 分类正文骨架

| 类型 | 正文骨架 |
|---|---|
| 权威面（根） | 头部（含读者/纪律） → **目录表** → 编号 `## N.` 节 → 修订史归 git 不写文内 |
| `design/` | 状态+上游 ADR/issue → 词汇/不变量/拒绝闭集 → 判定记录（「为什么不做什么」必留） |
| `rfc/` | `§0 摘要与决策请求`（结论先行） → 问题 → 选项/调研 → 方案 → 落地计划（每阶段可叫停） → 决策门与风险登记 → 与仓库纪律勾稽 → 附录（来源） |
| `research/` | 头部（含信源纪律：一手优先、二手标注） → 结论先行 → 正文 → 参考文献全表 |
| `milestones/` | 里程碑号/段 + 呈决策门 → 产出正文；冻结后头部标 `frozen` |
| `evaluation/` | **证据边界声明**（什么算/不算证据） → 契约/台账正文 |
| `ops/` | 用途 + 最近更新日期 → 操作步骤/上架材料正文 |

## 5. 生命周期规则

- **RFC**：拍板前 `proposal`；拍板后改 `accepted`（保留原文不动，正文吸收进权威面）；后续演进只改权威面。
- **调研/里程碑备忘**：定稿即 `frozen(日期)`，之后只允许改头部状态，不改正文（历史保真）。
- **权威面**：持续演进，`living`；提交只更新 `architecture.md` §11 定义且事实确实变化的专职权威面，其他文档保留短指针。
- **设计文档**：`proposal → accepted → active`；被权威面吸收后状态标注并让渡。

## 6. 引用纪律

- 移动/重命名任何文档，**同一提交内**更新：根 README 双语索引表、`architecture.md` §12 文档地图、引用它的代码注释与脚本串；双语对的两侧同进退。
- 文档间互链一律用相对路径 markdown 链接，不用裸文件名（裸文件名移动后无法机械校验）。中文镜像内互链指向对方的 `.zh-CN.md`，英文基座内互链指向基座名。
- `AGENTS.md` 契约钉住的四条基座路径（`architecture.md`、`gotry-master-outline.md`、`tokens.md`、`release-notes.md`）与发布闸读的 `docs/release-notes.md` **不可移动**；其 `.zh-CN.md` 镜像随基座同进退。确需移动须先改契约与 `scripts/publish-npm.sh`。

## 7. 可读性纪律（2026-09-05 全仓去冗后立）

可读性不是润色，是文档的可用性指标。规则：

1. **速览前置**：超过 80 行的文档，头部块之后必须有「速览」或摘要段（3–7 条），读完即可回答「这篇讲什么、结论是什么、跟我有什么关系」。例外：已有执行摘要/Goal 段的文档不重复加。
2. **一句一义**：单句不超过一个判断；多重括号嵌套摊平为独立短句；单条 bullet 只承载一个事实，装不下就拆子项。
3. **篇内去重**：同一结论／事实在篇内只写一遍，重复处删除或改指针（「见 §x」）；跨文档去重按权威面让渡——细节归专职文档（如 benchmark 逐轮台账归 `evaluation/benchmark-environment-bridge.md`），其他处只留摘记与链接。把同一实现段落复制到多个状态面属于缺陷。
4. **枚举下沉**：清单/参数表/逐条理由进表格或文末附录，正文留结论。
5. **版本历史归 git**：文档内**不写修订史/变更日志节**；历史状态叙事让渡给 `release-notes.md` 与各文档的 frozen 头部。
6. **状态诚实**：文档头部状态与实际结算保持一致（已立项就不写「待拍板」）；陈旧状态发现即改，不顺手留。
7. **证据保真红线**：transcript 原文、逐字引述、fixture/命令/版本号一个字不改；可读性优化只动评述行文。

## 8. 总索引

### 根目录（现行权威面，双语成对）

> 下表链接中文镜像；英文基座同名去掉 `.zh-CN` 后缀。

| 文档 | 关注点 |
|---|---|
| [architecture.zh-CN.md](architecture.zh-CN.md) | 唯一技术权威面：系统/模块/ADR/演进/债务/保鲜机制 |
| [gotry-master-outline.zh-CN.md](gotry-master-outline.zh-CN.md) | 总纲：工作分解/复用矩阵/决策门 |
| [gotry-product-design.zh-CN.md](gotry-product-design.zh-CN.md) | 产品设计：主循环/透明机制/全成本模型 |
| [roadmap.zh-CN.md](roadmap.zh-CN.md) | 唯一时间线：M0–M6 里程碑与当前位置 |
| [tech-strategy.zh-CN.md](tech-strategy.zh-CN.md) | 技术选型与半年迭代路线（M2–M4）：选型矩阵/评测/决策登记 |
| [data-sources.zh-CN.md](data-sources.zh-CN.md) | 唯一数据源权威面：领域矩阵/新鲜度/证据链契约 |
| [user-guide.zh-CN.md](user-guide.zh-CN.md) | 终端用户使用指南 |
| [tools.zh-CN.md](tools.zh-CN.md) | 工具参考面：注册工具分组、逐工具契约、通道路由、web onboarding 与运维脚本；清单数量以代码为准 |
| [release-notes.zh-CN.md](release-notes.zh-CN.md) | 逐版本发布决策（「为什么」，人写决策面） |
| [tokens.zh-CN.md](tokens.zh-CN.md) | token 唯一权威面：npm 2FA/发布机制/渠道获取表 |
| [decisions-needed.zh-CN.md](decisions-needed.zh-CN.md) | 待创始人拍板的决策队列 |
| [g5-authorization-ledger.zh-CN.md](g5-authorization-ledger.zh-CN.md) | G5 内部差旅桥授权台账（GRANT 条目仅创始人侧维护；由 `ts/scripts/g5-guard.ts` 机械读取，issue #348） |
| [debt-archive.zh-CN.md](debt-archive.zh-CN.md) | 已清偿债务存档（追加式留证；开着的债见 architecture.zh-CN.md §10.1） |

### design/（模块设计）

> 下表链接中文镜像；英文基座同名去掉 `.zh-CN.md` 后缀。

| 文档 | 关注点 |
|---|---|
| [design/memory-design.md](design/memory-design.zh-CN.md) | 记忆域设计：C 端六层重设计（M4 交付） |
| [design/memory-lifecycle-collector.md](design/memory-lifecycle-collector.zh-CN.md) | M4 lifecycle collector 使用合同：显式 opt-in、隔离 stateRoot、HMAC/consent、原子持久化与 #223/#238 scorer 导出；仅产出 candidate/synthetic，不替代真实 cohort |
| [design/milestone-delivery-plan.md](design/milestone-delivery-plan.zh-CN.md) | M4→M6 living 任务图（issue #225）：#20/#22/#136/#137 真实 gate、#231–#235 后继与 #270 公开交付台账；预准入只含获授权的设计/只读/fixture/failing-before 工作 |
| [design/write-gate-production-design.md](design/write-gate-production-design.zh-CN.md) | M5 WriteGate 生产化 proposal（issue #225/#136）：HotelByte 版本/发布物、可信 receipt 发行/消费权威、approval_claims 持久化、query miss 保持 unknown、对账/补偿/披露 |
| [design/fact-writegate-seam.md](design/fact-writegate-seam.zh-CN.md) | fact-anchor × M5 WriteGate 接缝（issue #303，#273 子切片）：读路径闸与写路径闸的契约、five-step 最小链、non-success 写 receipt fail-closed、依赖 #136/#231，M5 Entry 前不启封 |
| [design/effect-interpreter.md](design/effect-interpreter.zh-CN.md) | 效应解译器设计（accepted，ADR-18）：词汇/韧性策略表/判定记录 |
| [design/booking-saga-fsm.md](design/booking-saga-fsm.zh-CN.md) | 预订 saga 状态机（accepted，ADR-17）：字母表/边表/M5 缝词汇 |
| [design/tool-orchestration-design.md](design/tool-orchestration-design.zh-CN.md) | 工具编排与通道健康面设计（proposal，issue #106/#107/#108） |
| [design/adapter-authoring-guide.md](design/adapter-authoring-guide.zh-CN.md) | Session 适配器作者手册（D-13，#272）：四步法/漂移锁/红线 |
| [design/external-event-seam.md](design/external-event-seam.zh-CN.md) | 外部事件驱动接缝设计（#82 方向/D-31，只设计不承诺实现） |
| [design/itinerary-html-renderer.md](design/itinerary-html-renderer.zh-CN.md) | 行程 HTML 渲染器合同 + 产品生成入口（内部切片，issue #442/父 #438）：纯有界渲染器、计划面与证据面分离、拒绝集；`gotry_itinerary_render` 从注册表选出的事实在会话工作目录仅新建一个不覆盖的 HTML 文件；原生 HTML preview 实证在 #448 已接受，持久回归落在 `ts/scripts/dsh-artifact-web-e2e.ts` |
| [design/hotelbyte-skills-design.md](design/hotelbyte-skills-design.zh-CN.md) | hotelbyte-skills 架构（知识进仓/执行留 gotry，issue #5） |
| [design/stage1-top-down-design.md](design/stage1-top-down-design.zh-CN.md) | 冻结的 Stage 1 顶层设计；当前状态让渡给架构与路线图 |
| [design/lavish-local.md](design/lavish-local.zh-CN.md) | Lavish 本地会话适配器（#443，父需求 #438）：自有进程/端口/状态边界、TOON 协议事实、不可信反馈、有界轮询 |

### rfc/（提案原文）

| 文档 | 关注点 |
|---|---|
| [rfc/transactional-state-rfc.md](rfc/transactional-state-rfc.zh-CN.md) | 事务化状态基座 RFC（accepted 2026-08-28，ADR-15） |
| [rfc/user-session-data-rfc.md](rfc/user-session-data-rfc.zh-CN.md) | 用户会话数据面 RFC（已立项 2026-08-28）：官方通道优先+会话补缺 |
| [rfc/loopx-inspired-upgrades-rfc.md](rfc/loopx-inspired-upgrades-rfc.zh-CN.md) | LoopX 映射升级 RFC（accepted 2026-08-27）：四道接缝最小切片 |

### research/（调研与复盘，冻结）

| 文档 | 关注点 |
|---|---|
| [research/maka-research.md](research/maka-research.zh-CN.md) | Apache Maka 研究 → ADR-15 五件套逐项对照（底稿供拍板） |
| [research/deerflow-research.md](research/deerflow-research.zh-CN.md) | DeerFlow 研究 → 优化目标 T1–T4（issue #10） |
| [research/enterprise-travel-reference-study.md](research/enterprise-travel-reference-study.zh-CN.md) | 企业级差旅 Agent 八维参考研究（2026-09-03，来源脱敏） |
| [research/dsh-plugins-shortlist.md](research/dsh-plugins-shortlist.zh-CN.md) | dsh 社区插件选型调研（issue #9） |
| [research/kimi-postmortem.md](research/kimi-postmortem.zh-CN.md) | Kimi 行程对话复盘：反例教材与地面真值提取 |

### milestones/（里程碑备忘，冻结）

| 文档 | 关注点 |
|---|---|
| [milestones/demo-plan-2026-07-17.md](milestones/demo-plan-2026-07-17.zh-CN.md) | 首个可用 demo 交付（普吉岛 workation） |
| [milestones/demo-reconciliation.md](milestones/demo-reconciliation.zh-CN.md) | Demo 对账书（P0-5） |
| [milestones/g1-market-memo.md](milestones/g1-market-memo.zh-CN.md) | G1 首发市场锁定决策备忘 |
| [milestones/m2-capability-gap.md](milestones/m2-capability-gap.zh-CN.md) | M2 段 1：hotelbyte-cli 命令缺口盘点 |
| [milestones/m2-flight-data-options.md](milestones/m2-flight-data-options.zh-CN.md) | M2 段 2：机票免费数据源选型（§7-1 决策门材料） |
| [milestones/m3-web-gap.md](milestones/m3-web-gap.zh-CN.md) | M3 段 1：最小 Web 面实测与差距清单 |
| [milestones/m4-calibration-questions.md](milestones/m4-calibration-questions.zh-CN.md) | M4 校准发问清单 |
| [milestones/m6-b2b-reuse-walkthrough.md](milestones/m6-b2b-reuse-walkthrough.zh-CN.md) | M6 P6 B2B 复用推演纪要（draft，待 founder 评审） |
| [milestones/s1-walkthrough.md](milestones/s1-walkthrough.zh-CN.md) | S1 契约走查结论 |

### evaluation/（评测体系）

| 文档 | 关注点 |
|---|---|
| [evaluation/evaluation-foundation.md](evaluation/evaluation-foundation.zh-CN.md) | Evaluation Phase 0：契约/注册表/准入与边界声明 |
| [evaluation/benchmark-environment-bridge.md](evaluation/benchmark-environment-bridge.zh-CN.md) | 外部 benchmark 桥：Phase 1 接缝与逐轮工程台账 |
| [evaluation/e2e-prompts.md](evaluation/e2e-prompts.zh-CN.md) | dsh e2e 端到端真 LLM 验证记录（持续更新） |
| [evaluation/persona-bench/](evaluation/persona-bench/) | 产品人格横评：同一真实 prompt 各家回答存档/评分卡/人格提炼 |

### ops/（发布与合规）

| 文档 | 关注点 |
|---|---|
| [ops/extension-privacy.md](ops/extension-privacy.zh-CN.md) | Session Bridge 扩展隐私政策 |
| [ops/extension-webstore-submission.md](ops/extension-webstore-submission.zh-CN.md) | Chrome Web Store 上架材料与现行 dsh UI 安装交接（ADR-21 通道 B） |
| [ops/external-pr-workflow.md](ops/external-pr-workflow.zh-CN.md) | 公开 issue→PR→review→merge 台账；另载外部 PR（含自动化机器人）分诊/核验/裁决规则 |
| [ops/security.md](ops/security.zh-CN.md) | 安全策略与漏洞披露：上报通道、triage 纪律、append-only 安全事件台账 |
| [ops/ledger-tenant-repair.md](ops/ledger-tenant-repair.zh-CN.md) | #254 账本 tenant 修复 owner-gate 清单（dry-run → 授权 → apply → 私有回执） |

### assets/ 与 superpowers/

- `assets/`：archify 生成的系统架构图（`gotry-system-architecture.*`），由外部 archify 工具重生成，仓内无消费者。
- `superpowers/`：superpowers 工作流的 plans/specs（评测计划 Phase 0 等），工具自管。
