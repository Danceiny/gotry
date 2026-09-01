# GoTry Roadmap(唯一时间线)

> 定位:**从今天到愿景的唯一里程碑序列**。已有的三套阶段模型(architecture 的 Stage 0-4、总纲的 Phase 0-3、产品设计的 M1-M3)全部归并映射到本文的 M0-M6,旧模型降级为引用。
> 每个里程碑:进入/退出条件、交付物、gate(谁拍板)、依赖。**当前位置用 ← 标注。**
> 状态细节仍以 `architecture.md` §9-10 为准;本文只管时间与顺序。

---

## 当前位置(2026-08-27)

### 发行状态

**当前 npm latest = `0.0.1-rc.15`;rc.16 tag 已推但 npm 发布未落地。**

- 2026-08-30 #50 核实:registry versions/dist-tags 均无 rc.16、GitHub Release 亦未建——发布凭证缺位,补发待 founder 浏览器 approve 窗口。
- **勘误**:此前「registry 回拉实测全过」的记载不实(#50 勘误)——publish 实际未完成。
- rc 逐版范围见下方「rc 序列总览」与 `release-notes.md`。

Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures/test-only aggregate admission plus a deterministic PR/nightly/weekly/milestone cadence policy/planner. It returns admission, `pass^k`, budgets, calibration, failure-registry, and cross-benchmark synthesis obligations only; it does not schedule or launch adapters, spend, generate a benchmark score, create an Agent optimization round, or support an uplift claim. No external runner, Python runtime dependency, baseline, or matched production evidence is included.

### 架构面增量(未随版本发布,主仓领先已发包形态)

> 以下均为**工程面交付,不构成任何里程碑 Exit 证据**(D-20 口径)。

- **效应解译器(2026-08-29,issue #16,ADR-18)**:`effect_interpreter.v1` 落地 L4 渠道边界——指数退避重试 / 断路器 / mock 解译器(纯离线 CI 面)收敛进解译层;五渠道工具 + realtime-pricing 已接,余下渠道增量迁移(D-23)。run-all §37。OTA 工具面照旧平铺,证据链逐源标注不变。
- **可下单事实闸(2026-08-30,issue #46,ADR-19)**:`gotry_bookable_fact.v1` 单一数据源 + 产物事实闸——flyai/session exact-date 检索结果 hit/miss 逐条落账(query_id 可重放),**exact-date miss 禁止用历史班期/相邻日期/航线页回填**;`gotry_fact_gate` 交付前必过(claim 反向抽取回溯 + 夜数/O&D/预算不变式),blocked 不得宣称「已验证方案」;persona (20) 红线化。run-all §39 locked golden 2027 E2E + smoke §16。覆盖面缺口记 D-26。
- **npm 形态自定义端点修复(2026-08-30,issue #48)**:bin env 映射补 `LLM_BASE_URL → DEEPSEEK_BASE_URL`——rc.15 回拉实测暴露只映射 key 不映射 base,OpenAI 兼容端点 key 被发往 DeepSeek 官方端点必然 401。修复后三件套 `.env`(`LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL`)即全链通;显式 `DEEPSEEK_BASE_URL` 仍优先,默认官方路径零改变。dsh 侧(llm-deepseek)与仓内 `dsh-llm.ts` 拼接语义核验一致(`${base}/chat/completions`)。README 双语 + `.env.example` + bin help 同步。
- **价表 v2 + 价格漂移长机制(2026-08-30,issue #49,ADR-20)**:
  - 封存价表 v1(DeepSeek V4 only)升 v2(provider-aware,`gotry_llm_price_table_v2`);MiniMax M2/M2.1/M3 入表;`ts/scripts/price-drift-watch.ts` 覆盖四家主流 provider,默认离线对照 baseline 比对输出 PR-就绪 Markdown diff,**永不自动 apply 价格**(ADR-11 纪律——founder 实测「自动 apply 易把官方 down 5% 误认为我的 bug」)。fetch/解析失败 → SKIP + reason,零写未知数据。
  - run-all §41 合同验证 8/8。同批 CHANGELOG 机制(`ts/scripts/build-changelog.ts` + `CHANGELOG.md`,`publish-npm.sh` 闸自动跑 + `gh release create`)与 §38 扩展桥 zombie port 根治。

### M3 真实证据并行线(Issue #22)

- manifest 冻结样本窗口、纳排、分母、归因与 Exit 阈值;脱敏 cohort/nightly schema 和确定性 scorer 已有 synthetic fixture 守门。
- **fixture 只能证明合同与公式,永不算 business pass。**
- nightly real-LLM 证据生产器 `nightly-evidence.ts` 就位(封存 prompt 集 + 价表,无凭证 waiting/backoff/no-spend 零写入,run-all §35)——验收⑥「nightly 可复跑」的机械前提闭合,真跑记录待凭证环境。
- **当前没有 50–200 人真实 cohort,M3 Exit 仍开放。**

### 会话 benchmark(Issue #67)

- `sf-live-benchmark` 新增 `--golden=static`:以 OpenFlights ODbL 固定修订提供航线/承运人,以 `sf-golden-manifest.json` 提供估算时刻与价格带。
- evidence 分开记录请求源与实际源(`requested_source`/`effective_source`)、estimated fields、provenance 与 fallback reason;快照或路由异常会向 stderr 明示后回退 `manual-golden`。
- **这是可复跑的 benchmark 对照源,不是实时班期、票价或库存**;真实会话侧仍须用户 Chrome 扩展连接。离线守门列入 run-all §44,不改变 M3/M4 里程碑口径。

### Agent evaluation 反馈闭环(Discussion #78)

- ChinaTravel grounding-v3 冻结 canary 的首例可评分终态通过,第二例因 planner 重复工具循环超过 300s；当前只允许报告 `attempted=2/scored=1/timeout=1`,不得外推 5-query aggregate。
- Round 1 聚焦 GoTry 自身:模型每轮第 16 次真实工具派发注入收敛上下文,第 18 次是最后一个 body；同一步第 19 次起返回 `TOOL_BUDGET_EXHAUSTED`,该批 `step/end` 后下一步 native 请求抑制继承工具 schema。run-all §45 已覆盖 Cordis integration/并行/turn+session 生命周期及真实 npm-mode dist + dsh headless 离线 E2E(18 body、1 structured refusal、下一请求 text-only、非空 final)；CI 以当前 SHA tarball 的隔离 pnpm consumer 入口重放同一链路,不借 root 开发树。
- 外部验收仍是 TODO:Round 1 treatment-attested installed GoTry 的 exact DeepSeek 为 environment unavailable/schema-invalid 0，GLM 为 300 秒 timeout。Round 2 的唯一冻结 treatment 只算 diagnostic-only：agent 没有把 CLI/shell 指令转成唯一 native bridge call，终态也没有 tagged JSON。Round 3 修复该通用 conformance 缺口后，新冻结 treatment 的 provider preflight 通过且 runner 只派发一次，但 planner/runner 均 exit 1，3.796 秒内停止，parent 释放 0 字节，evaluator 未进入，official scores 仍全为 null。Round 4 treatment（SHA `5ebddb2`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，释放 0 字节，evaluator 未进入，official scores 全为 null；产品 gate 是 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属。新的 final-head treatment、七指标与 overall 仍待独立证据，不得声称 external benchmark closure。
- **Phase 1 bridge 当前态**:Round 2 已有 default-off owner-local bridge contract，固定 executable/cwd/argv_prefix/allowlist 与 timeout/output caps，并可按工具配置 `allowed_output_keys` 正向 visible-output 键合同，未声明键 fail-closed 且不反射。opt-in 仅允许 cold-start；每个 benchmark agent 强制 native、原始 bridge definition-only，最终 assembly 与 downstream pre-step 双闸拒绝额外 schema/同名 shadow/PTC 漂移。Round 3 增加 provider-neutral conformance：system contract 把 CLI/shell/Python 操作映射成 `query.action=call`，只有 allowed call 的配对成功 result 后才接受 owner-local `terminal_output` 指定的单一 tagged JSON object；缺 call 或坏终态最多纠偏一次，格式纠偏禁止重复派发 bridge，headless parent 用同一 parser 二次验收 stdout。Round 4 在 config 验证后、任何 optional host plugin 解析前，把 benchmark patch 的顶层 insert 投影为唯一 `gotry-tools`；inline/reordered/未来非 GoTry insert 全部裁掉，`gotry-tools` 或 config-path 注入锚点缺失/重复均在 spawn/relay 前 fail-closed，default-off 组合不变。agent disposal 释放 scoped effect；插件先卸载时 live agent 保持 fail-closed quarantine 到 agent/process disposal，HMR 不热挂。config 要求 writes forbidden/network denied，但真实 enforcement 由 owner/host OS 负责，synthetic E2E 不证明 OS sandbox。bridge 不引入 Python/benchmark runtime 产品依赖。Round 4 treatment（SHA `5ebddb2`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，释放 0 字节，evaluator 未进入，official scores 全为 null；产品 gate 使用 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属。
- **Round 5 runtime resolution**:source checkout 与 clean package 都解析同一组 216 个精确直接依赖的 DSH `0.1.2-alpha.3` closure；manifest、package-lock 与 root pnpm importer 的 DSH 名称集合必须同为 216，publish preverify 对漏钉、混版或 range 声明 fail-closed；source 普通运行的 dsh cwd 保持 `ts/dsh-runtime/`，状态继续落 `ts/dsh-runtime/gotry-state/`，benchmark opt-in 与 npm package 使用调用目录隔离；legacy vendored alpha.1 仅作非 benchmark 解析兼容，不承诺可运行。benchmark 在 spawn 前拒绝实际版本漂移；Node 下界统一为 22.15，并在 DSH import/spawn 前 fail-closed。legacy vendor 的整体升级留在独立 PR，不混入本轮。
- **验收 evidence(2026-08-30)**:登录态 Chrome 连续两轮真跑——static official 均 8/8 hit、零 fallback;session 分别 3/8 与 5/8 hit,全部可评分 hit(3+5 条)均 13/13 = 100%,非 hit 明示 miss。**评分门通过不等于 8/8 可售性。**
- 同轮清偿:真扩展在线时默认桥不退出的存量缺口——parked timer/socket 只在默认桥 `unref`,wizard `keepBridge` 不变;§38 24/24、§40 9/9。

### 配置面修复(2026-08-30,issue #77)

三件套 `.env` 的 `LLM_MODEL` 此前在 dsh 会话面**零消费者**(#48 E2E 暴露:mock 中转配了 `LLM_MODEL`,请求体 model 仍是 `~/.dsh` 用户层选择),严格中转(仅认特定模型名)打不通。修复双轨:

1. bin 映射 `GOTRY_LLM_MODEL`,gotry-tools 插件 `agent/request` 瀑布内存覆盖(dsh settings 用户层 > composition 层,单靠 patch 压不过;覆盖零持久化,不改写 `~/.dsh`)。
2. 运行时 cordis patch by-id 双覆盖(agent-default-model 默认模型 + llm-deepseek 目录单条目,不硬编码上游 `DEFAULT_MODELS`)。

默认路径保护:不设 `LLM_MODEL` 两轨均不动作,`.env.example` 默认行注释化。E2E `ts/scripts/model-override-e2e.ts` 四场景(mock 中转 + 隔离 `DSH_HOME` + clean tarball 安装形态,含「同 settings 仅差 env」对照)全绿;脚本现要求显式 installed-package bin，不再靠移动源码依赖伪装 package mode；smoke §17。附查发现 vendored 仓内形态 Node 兼容窗口断裂,记 D-27。

rc 序列总览(细节见 release-notes.md,版本历史归 git):

| RC | 状态 | 范围 |
|---|---|---|
| v0.0.1-rc.1 → rc.3 | 已推(tag) | 去 Python / npm 一键骨架 / headless 实测 / Anything 三仓落地 |
| v0.0.1-rc.4 | 已推 | agent-reach 接入(router 形态,后被 wrapper 化取代)+ License MIT |
| v0.0.1-rc.5 | 已发 npm(不可用,被 rc.6 取代) | 首发打通 2FA/恢复码/隔离发布命令;tarball 缺 runtime(教训) |
| **v0.0.1-rc.6** | **已发 npm,可用** | bin 运行时解析 + dist 预编译(绕 Node 拒 strip node_modules .ts)+ data 入包;干净安装 web 200 实测 |
| v0.0.1-rc.7 | 已发 npm;rc tag 仍滞留本版(可用但旧,#50② 迁移待授权窗) | .env 读用户当前目录 + 无 key 可执行指引 |
| v0.0.1-rc.8 | 已发 npm(曾直指 latest) | `npx @danceiny/gotry` 即得;干净安装 headless 实测跑通 |
| v0.0.1-rc.9 | 已发 npm(曾为 latest;**含缺陷:better-sqlite3 未入 dependencies,装得上跑不起**——被发布后干净安装验证抓出) | M4 记忆域全链/账本/17 工具/D-6 校准 |
| **v0.0.1-rc.10** | 已发 npm(曾为 latest;registry 回拉实测:489 包安装/插件加载/bin 全通) | 双形态冻结 ADR-16 + 会话传输层 puppeteer 定案 + 依赖面根治;rc.9 标缺陷由本版覆盖后退役 |
| **v0.0.1-rc.11** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/插件加载/bin 全通) | 已知限制清算:Z3 WASM race 根治(D-17)+ 实时票价桥(flyai overlay)+ i18n 英文面(工程层)+ 薄壳删除;run-all 新增 §30-§32 |
| **v0.0.1-rc.12** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/插件加载/bin 全通) | OTA 扁平化(flyai kind=hotel 酒店接入)+ 账号会话授权闸 v2(每会话一次/拒绝吊销/sessionAccess 总闸)+ 登录产品化(`gotry_session_login`,第 18 工具,零终端零凭证)+ dsh vendored alpha.1 + issue #24 三处修复 |
| **v0.0.1-rc.13** | **已发 npm,latest 直指本版**(registry 回拉实测通过) | 账号会话三连修复:登录自动检测(已登录零弹窗)+ 登录页置前可见性(`newPage` 纪律)+ 例行测试永不自动开窗;README 可读性一版(18 工具分组/账号会话隐私专节/状态重排) |
| **v0.0.1-rc.14** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/bin/npm 页英文 README) | 文档中英分开发布:`README.md`(英文,完整镜像)+ `README.zh-CN.md`(中文)互链,顶层 switcher;npm files 增补中文版 |
| **v0.0.1-rc.15** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/bin/插件加载全通) | issue #17 采纳:预订 saga 状态机具名化 `booking_saga_fsm.v1`(ADR-17,纯函数词汇层+§36 与账本物理对账)+ HITL 审批边/合规确定性边词汇;run-all 新增 §36 |
| v0.0.1-rc.16 | **tag 已推,npm 未发布**(registry 无此版本,#50 勘误;补发待授权窗) | issue #49 采纳:价表 provider-aware v2 + MiniMax 入表(ADR-20)+ 价格漂移监测长机制 + CHANGELOG 机制 + §38 扩展桥 zombie port 根治;run-all §41/§42 两闸。详见上方「架构面增量」 |
| dev(未发) | 持续 main 直推 | issue 冲刺 14/14 交付(README 一致性/域边界/数据污染根除等),17 套 ALL GREEN |
| 后续 | founder 侧 | 种子用户邀约;rc.16 补发 + dist-tag 卫生(rc tag→最新可用版、清杂散 rc.5/rc.11-rc.14)同一次浏览器 approve 窗口内做完(#50②③) |

**M3 工程面已推进但 Exit 未关闭；M4 自 2026-08-26 起由 founder 授权并行推进，不是 M3 Exit 证明。** M4 记忆域 T1 行为链已闭合（动态吸收→读回→效用→触达→度量），六层重设计已落地 `memory-design.md`，分期增量为 P1 旅行时间线→P2 同行人档案→P3 时间窗衰减→P4 双区会话后置。
  - **2026-08-28 会话数据面并行线(RFC `user-session-data-rfc.md`,loopx goal `gotry-session-data-goal`)**:P0 官方通道尽调(飞猪 FlyAI 无 key 只读,机/火检索官方主链路)+ P1 会话骨架(ReadGuard 物理只读/携程 batchSearch 嗅探/节律闸,登录态=存在前提)+ P2 action-cache 自愈层/美团骨架(a11y 兜底,匿名 403 实测)/金标准 20 查询/**#21 字段 fixture scorer+双源合同+waiting-attach no-spend 已落** + P3 工具面两工具(smoke §12,当时 17 工具)——与 M4 记忆域正交推进;
  - 待用户日常 Chrome 完成 remote debugging、权限确认和 CDP 握手后收尾真实 sf-01..08 双源跑批/真模型巡检。
  - **2026-08-28 事务化状态基座落地(ADR-15,RFC `transactional-state-rfc.md` accepted「按你的建议来」)**:
    - 「文件即权威」升级为「单文件 SQLite 账本即权威」——
    - events append-only + 投影 fold 重建 + 红线(evidence/conditions)进事务 + confirm-outcome 单事务 + 异步工单 durable 恢复(exactly-once；`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0，将非 4/4 映射为 `failed`/ledger `failed`/exit 2，终态复诵零重算且保持同一退出码)+ pending_writes saga(WriteGate M5 的 L2/L3 基座,D4 定为 M5 Entry 前置);
  - 旧 JSON/JSONL 降级为单向导出视图(红线 6),首写自动迁移+快照;run-all §28/§29,多用户账本化(RFC §6.5)触发式后置(D-15)。**同日 ADR-16 双形态架构冻结**:本地+Web 一套账本语义、tenant_id 一等字段(schema v2)、同步=事件复制非状态翻译——防「将来大规模重构」的核心冻结,founder 拍板「要的」。
  - **2026-08-29 已知限制清算第一刀(founder 指令「解决这些 known limitations」)**:Z3 WASM race 根治(`z3-shared.ts` 单一实例+会话级互斥,run-all §1 重试止血退役+§30 并发回归闸),薄壳遗留(`shell/`)物理删除——README Known limitations 中两条就此清偿,余两条同批推进:实时票价桥已接入(flyai overlay+env 闸,run-all §31),i18n 工程面落地(run-all §32:en 零缺键/zh 金标准逐字节),人格与工具卡的校准后补齐挂 M4。
  - **2026-08-30 会话传输层定案扩展桥(issue #21 方案 C,founder「逐连接权限框根本无法使用」实测定案)**:Chrome 144+ 每 CDP 连接必弹权限框且无持久化批准 → CDP 降显式 opt-in,自研 `extension/` GoTry Session Bridge(MV3 一次性安装,固定 key 扩展 ID)+ `node:http` 回环桥升 PRIMARY——系统弹窗每会话 0 次;登录快路径免标签页秒回;`needs-extension`=waiting no-spend;run-all §38 全离线 23 断言;真实 sf-01..08 双源跑批门禁降为「装一次扩展」,与 #16/#22 同属等外部输入的 no-spend 等待面。
  - **2026-08-30 同批 onboarding UX 闭环(issue #21 P3.6,loopx `gotry-session-onboarding-goal`,founder 实测「能装≠装到能用」补设计)**:5 步编排 + 剪贴板扩展路径 + 跨平台 GUI 面板(macOS osascript / Linux zenity / Windows msg / headless 终端降级,**不引 Electron**)+ 后台 health-watch ≤120s 探活 + 扩展一就位 stdout 翻绿自动重放同 query_id——用户侧降至 **3 次点击 + 0 次终端命令 + 装完零重跑**(对照上版 5 次点击 + 1 文件对话框 + 跨 app 切换 + 装完自己重跑);
  - `npx gotry setup wizard` 单命令入口,`ts/capabilities/session/{wizard,health-watch}.ts` + `scripts/health-watch-cli.ts`(bootstrap spawn tsx 子进程)+ bootstrap `wizard` 子命令(inline 降级兜 npm 安装态);run-all §40 onboarding-tests 9/9 + bootstrap-tests 7/7 wizard 节;RFC §3.3/§4 P3.6/§6 复用矩阵同步。
  - **2026-08-30 同批 P3.7 双源 e2e 真跑批(goal 2,commit `60669f8`+PR #66 follow-up)**:founder 实问「flyai 只是一个 vendor,可以切别的?」→ **拒 vendor 锁**,official golden 改 pluggable(默认 `manual-golden`=`ts/data/sf-golden-manifest.json` 公开班期 + 价格带 + 软命中评分;`--golden=flyai` 显式切);`ts/scripts/sf-live-benchmark.ts` + `ts/scripts/sf-summary.ts` 重建 unified summary;
  - 本机实测 8 query:**7/8 verdict=hit / 6/6 manual-golden 软命中 100% / live <15s 7/7 / ReadGuard 0**;issue #21 验收清单「sf-01..08 完成真实双源 e2e + 字段准确率 ≥90% + live <15s」**全数达成**;evidence 落 `~/.gotry/evidence/session/sf-XX/<ts>.json` + sf-summary。后续 goal 3 vendor 接入由 founder 决定(hbcli / 携程开放 API / 内部 static 包兜底)。
  - **2026-08-30 同批扩展分发双通道(issue #21 分发通道,ADR-21)**:founder 指令「产物下载和安装也得做成更好的用户体验,可以用 github 作为分发渠道」——Chrome 平台约束(GitHub 只能改善下载,一键装+自动更新只有 Chrome Web Store)下双通道:GitHub Releases 下载通道已落(`gotry setup --extension-from=github` 显式 opt-in,稳定资产名三件套 + SHA256 + key 钉扎 + 失败显式降级 bundled,扩展更新与 npm rc 发版火车解耦;`scripts/package-extension.mjs` 只产产物,上传走发布确认制);
  - Web Store 上架材料就绪未提交(单一用途/权限理由/隐私披露/文案 + 隐私政策,`docs/extension-webstore-submission.md`,注册与提交归 founder=D-25);run-all §43 + bootstrap-tests 8/8。

**M4 Issue #20 证据切片(2026-08-29)**:paired cohort 合同与只读 synthetic fixture scorer 已落地,固定唯一匿名 subject、returning 晚于 first、active planning duration 扣除预声明 external waits、N/p50/p75/逐 pair reduction、experience reflux、偏好溯源/硬过滤红线与 P4 trigger 闸。合成 N=3 明确 `exit_evidence_eligible=false`;当前瓶颈是私有真实 `observed_private` N≥5 repeat cohort,无样本时 waiting/backoff/no-spend。

**2026-08-29 第二批:OTA 平铺 + 账号授权闸(founder 口径「OTA 这些都是工具,不要区分什么主路径/降级路径;这要用到用户的账号,所以必须跟用户确认」)**:飞猪 `search-hotel` 接入(`gotry_flyai_search` kind=hotel,打码价保真);OTA 工具描述与 persona (19) 去「三级路由/主链路/交叉验证」层级,改平铺工具面(证据链逐源标注不变);账号会话工具授权闸进代码——v1 逐调用弹卡经 founder 实测(「每次都要弹,经常无法点击」)当批改 v2:**每会话每站点首次调用**弹 dsh 原生审批卡、批准后会话内记住;**拒绝=本会话吊销**(不再弹卡不再执行);无审批通道(headless)一律 fail-closed;
  - `sessionAccess: ask|allow|off` 总闸(`session-consent.ts`)。**④登录产品化(第 18 工具 `gotry_session_login`)**:needs-login 时 agent 直调——在用户 Chrome 弹携程登录页等用户在**携程官网**完成登录,无需终端;语义红线=登录永远发生在外部网站,gotry 永不经手密码/验证码/cookie 值(只读票据名,0 值过手;登录引导页不挂 ReadGuard——凭证流绝不被我们拦截,transport `guard:false` 唯一豁免面);③例行动回归永不自动开浏览器窗口(live 探针 GOTRY_SESSION_LIVE=1 opt-in);携程酒店/美团会话适配器仍等登录态 seam(独立 tick,见 data-sources §8)。

**2026-08-29 产物面最小切片(issue #25)**:第 19/20 工具 `gotry_artifacts_list`/`gotry_artifacts_read`——账本工单交付与工作目录产物在 dsh 内可发现、可读(read 卡行号文件视图,只读,smoke §13);面板第二切片同日:dsh-market 选型 **dsh-better-sidebar**(18.9 万周装,#1 UI)经 `gotry setup` 宿主层安装,dsh web 侧栏工作台直接渲染工作区产物(自建 webui 撤回);账本感知产物 Tab 下一阶段。

**2026-08-27 时间感优化落地**(外部时间评测驱动,ADR-12):时间锚点层 + 槽位抽取 v1 + 25 题评测集进仓,真模型 25/25;细节见 architecture.md §1/§9 与 ADR-12。

(历史)**M2 已退出**(b0cfd97):§7-1 三层组合全链落地——OpenFlights 骨架(168 枢纽对,三值语义,求解消费+用户渲染双层)+ OpenSky 校验桥 + bookedResources 锚点 + hbcli 酒店桥(gotry_hotel_search,实时/静态降级);dsh 运行时端到端(DeepSeek 原生,人格+五工具);一键成品入口 `./gotry` 经全新场景验收(带爸妈云南行:人格问对问题→引擎三候选判决→证据链→三道选择题)。G1 已决(中国出境首发)、S1 已冻结、§7-1 已批——均由创始人「按推荐方案执行」指令结算。**当前 = M3 最小可用产品**:最小 Web 面(D-4)+ 种子用户 50-200 人(发起人即首个用户,`./gotry` 即入口)。

## 里程碑总表(三线并行:技术/产品/商业)

| # | 里程碑 | 技术线 | 产品线 | 商业线 | 状态 |
|---|---|---|---|---|---|
| M0 | 确定性管道 | 引擎双实现+真实数据包+对账框架 | demo 规划书 | — | ✅ |
| M1 | **Agent 形态成立** | LLM 进环(S1-S5) | 对话即界面(gates 选择题) | — | ✅(2026-08-22,`bb880f3`) |
| M2 | 实时数据 | hotelbyte-cli 桥+航班源(免费/开源优先),静态包退役为夹具 | 证据链换血([估算]→[实时API]) | 数据源选型(免费/开源优先) | ✅(2026-08-22,`b0cfd97`) |
| M3 | 最小可用产品 | 最小 Web 面(D-4 偿还)+ cohort evidence scorer | 透明卡片/动机访谈可体验;种子用户 50-200 人 | **G1 市场锁定必须在此前完成**;种子即洱海+普吉两类场景 | ← **evidence 未收口** |
| M4 | 记忆与「下一次出发」 | 六层 memory 的 C 端域实现;wish pool 联动回访 | 北极星(下一次出发率)开始度量;对账七题=首批校准 | 订阅形态验证(¥49/年锚) | **founder 授权并行，非 M3 Exit**（#20 scorer 已落地；真实 `observed_private` N≥5 待） |
| M5 | 交易闭环 | WriteGate 上生产;预订/支付/退改 | 佣金披露上线;红线随行 | 三层收入全开(免费/Plus/佣金) | 未来，仅受 M5 Entry gate 开闸 |
| M6 | B2B 包裹 | principal/sponsor 插件化,内核零改动跑通旅行社嵌入 | 两层为什么实证 | 「99% 复用」从论断变实测;B2B 试点 | 未来，仅受 M6 Entry gate 开闸 |

## 里程碑详情

### M1:Agent 形态成立(✅ 2026-08-22,commit `bb880f3`)
- **Entry**:✅ 统一模型、契约草案、mock 垂直切片、异步闭环、真 LLM 适配器(全部完成)。
- **Exit 达成(= Kimi 复盘的验收标准)**:真 LLM(MiniMax-M2,provider-neutral 适配器,`LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`)通过 `replay-real.ts` 重放——同一开场白 3 轮交付已验证方案,首轮问出工作窗口与已订资源,零日历错误、零完全重排,全程无人代劳翻译。过程中诞生 ADR-10(翻译≠造数)。
- **结转**:S1 契约走查(三走查点:Gate 只允许选择题/workWindow 必带 evidence/assumptions 三分类)转入 M2 Entry;S5 后半(loopx tick 真驱动)挂 M3。
- **不许做**:真实供应链、UI 工程、B2B。

### M2:实时数据(✅ 2026-08-22,`b0cfd97`)
- **Entry**:M1 exit ✅ + 两个创始人输入:① S1 契约走查(自 M1 结转);② 机票数据源决策——无商业合作期走免费/开源优先组合(免费额度官方 API + 公开数据集 + 用户已订资源自带),商业供应链后置 M5(见 `tech-strategy.md` §2);酒店=hotelbyte-cli import+extend(已决)。
- **交付**:capability-hotelbe 插件、航班数据桥(OpenFlights 骨架+OpenSky 校验+bookedResources 锚点);deprecated 层迁移(D-7)未做,顺延 M3 早期(见 §10)。
- **Exit**:同一 JourneySpec 实时 vs 静态的求解差异可度量、可归因。

### M3:最小可用产品(← evidence 未收口;产品里程碑与商业 gate 交汇点)
- **Entry**:M2 exit ✅ + **G1 市场锁定** ✅(中国出境首发,创始人「按推荐方案执行」指令结算,`b0cfd97` 同批)。
- **交付**:最小 Web 面(透明卡片+动机访谈+gates 的可体验形态,D-4 清偿);种子用户 50-200 人邀请制;Issue #22 evidence manifest、脱敏 schema 与确定性 scorer 已进入工程面，真实样本只进私有且被忽略的 `ts/gotry-state/evidence/m3/`。
- **Exit**:种子用户行程定稿率 ≥40%、NPS ≥40、POI 幻觉 <1%(评测三件套全绿)。

### M4:记忆与「下一次出发」(founder 授权并行;非 M3 Exit 证明)
- **Entry**:正式里程碑 Entry 仍是 M3 exit；当前仅由 founder 授权并行工程切片，不改变 M3 Exit 判定。**交付**:C 端记忆域(六层框架重设计)、主动回访(可关闭)、北极星开始度量;对账七题答案=红眼模型与偏好的首批校准样本。Issue #20 scorer 已落地，真实 `observed_private` N≥5 repeat cohort 仍是 M4 Exit 前置。
- **Exit**:回访用户规划时长较首访降 ≥50%;经验回流率有基线。

### M5:交易闭环
- **Entry**:M4 exit + 供应链协议。**交付**:WriteGate 生产化——写权按 L0-L4 渐进授权(L2 建议/L3 具名 seam 确认带 receipt/L4 自动类),每级可回滚(RFC S4);预订/支付/退改;佣金披露(红线随行)。**设计基座已备(2026-08-29,issue #17 采纳/ADR-17)**:预订 saga 状态机词汇层(`booking_saga_fsm.v1`,`ts/src/booking-saga.ts` + `docs/booking-saga-fsm.md`)——字母表/四条边全函数边表/拒绝闭集/审计链校验,run-all §36 与账本物理对账;启封时任何 booking seam 只许走该边表;空 receipt 物理 CHECK、seam 命名词汇、L2/L4 接线与审批等待态为 M5 交付物。
- **Exit**:预订零误操作事故;单位经济实测(对齐 D1 §8)。

### M6:B2B 包裹
- **Entry**:M5 exit + P6 推演确认。**交付**:principal/sponsor 分离插件化,一个 B2B 场景(旅行社嵌入)零内核改动跑通。
- **Exit**:「99% 复用」实测数字;B2B 试点签约。

## 最短路径:现在 → M3 exit

```
你:remote 目标 + License 两个决策      ← 发布闸④⑤,种子用户的前置(发布 owner 等这两个答案)
你:种子用户邀请(发起人即首个用户)      ← ./gotry 即入口(v0.0.1-rc2)
工程:D-7 迁移(候选形态进 TS unified,清除洱海路由 hack)→ 指标面板(ADR-11 质量层)
```

## 旧模型映射(归并即退役)

| 旧模型 | 位置 | 映射 |
|---|---|---|
| 技术 Stage 0/1/2/3/4 | architecture.md §9 | M0 / M1 / M2 / M4 / M6(M3/M5 是产品/商业交汇点,技术线横跨) |
| 总纲 Phase 0/1/2/3 | gotry-master-outline.md §5.1 | M0-M1 / M1-M3 / M3-M5 / M5-M6 |
| 产品 M1/M2/M3 | gotry-product-design.md §10 | M3 / M4 / M5 |

## 修订史
归 git(本文不设版本号)。
