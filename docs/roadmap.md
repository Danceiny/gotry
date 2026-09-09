# GoTry Roadmap(唯一时间线)

> 定位:**从今天到愿景的唯一里程碑序列**。已有的三套阶段模型(architecture 的 Stage 0-4、总纲的 Phase 0-3、产品设计的 M1-M3)全部归并映射到本文的 M0-M6,旧模型降级为引用。
> 每个里程碑:进入/退出条件、交付物、gate(谁拍板)、依赖。**当前位置用 ← 标注。**
> 状态细节仍以 `architecture.md` §9-10 为准;本文只管时间与顺序。

---

## 当前位置(2026-09-10)

### 发行状态

**当前 npm dist-tags(2026-09-10 只读观察):`latest=0.0.1-rc.22`,`rc=0.0.1-rc.20`。本行不把 `npm view` 观察当作干净回拉验证;历史 rc.18 回拉证据保留在下表对应版本行。**

- 2026-08-30 上午 #50 核实 registry 无 rc.16(「已发布」口径勘误);**同日 13:00Z 补发落地**(npm time 实测 `0.0.1-rc.16` = 2026-08-30T13:00:38Z),GitHub Release 13:03Z 随建(#76 修复生效)。
- 2026-09-02 #50② 收口:回拉实测 latest=rc.16(干净安装 489 包 / bin `--help` / dist 入口全通);`rc` 由滞留 rc.7 迁至 rc.16,杂散 `rc.5` 改指同名版本、`rc.11–rc.14` 各自同名自洽——五别名彻底删除需 npmjs web UI(granular token 对 DELETE dist-tag 端点 403,curl 复核同)。
- rc 逐版范围见下方「rc 序列总览」与 `release-notes.md`。

**评测边界(Phase 0/Phase 1)**:契约/注册表/校验器与确定性节奏策略已就位;不调度、不花费、不出分、不声称 uplift。全文见 `evaluation/evaluation-foundation.md`;逐轮 frozen treatment 台账见 `evaluation/benchmark-environment-bridge.md`。

### 架构面增量(未随版本发布,主仓领先已发包形态)

> 以下均为**工程面交付,不构成任何里程碑 Exit 证据**(D-20 口径)。

- **#271 Phase A 进程事故观察(2026-09-09)**:GoTry-owned `uncaughtExceptionMonitor` 记录 uncaught/rejection 并保留宿主 fatal 退出语义；single-fd append+fsync+close writer 失败返回 `false`；native Node24 ESM dist 反例覆盖 monitor/no-monitor、既有 host handler、fsync/close 与工具结构化失败。child close/spawn error、SIGINT、后代进程与上游 dsh supervisor 仍为开放 TODO，不改变 M3/M4-M6 真实证据 gate。
- **#282 Booking planner 纠偏(2026-09-09)**:planner 保留非空 occupancy 房间与 childAges,缺 `adults` 交给 schema 纠偏;每次 run(含纠偏)均计入最多三次调用,有效 correction 立即返回,provider error 不静默吞掉。focused proof 是注入 runPort 的工程证据,不改变 M3/M4-M6 或真实 Booking UAT gate。

- **#279 携程机票 malformed 响应闸(2026-09-10)**:合法空列表= `miss`,有效命中= `hit`,未知/畸形形状= `error`;兼容 `parseBatchSearch` 永不抛错,扩展/CDP 均不把 parser error 伪装成 miss。隔离扩展 fixture 仅证明本地解析/编排,不满足 #272 live interface calibration、真实 supplier evidence 或 M4/M5/M6 admission。

- **#327 严格重复 tool-call 参数修订(2026-09-10)**:Booking planner 保留普通单对象解析；恢复只接受完整消费的、至少两个、仅空白分隔且深结构相等的顶层 JSON 对象。公共 `runPort → tool/call` fixture 覆盖一致重复、冲突/截断/前缀/尾部垃圾拒绝及字符串花括号/转义；不宣称真实 provider reliability、HotelByte UAT、M3/M4 cohort 或 M5/M6 admission。
- **#329 安全 dispatch 日志(2026-09-10)**:同步 HTTP 409 turn-dispatch rejection 只写 typed `code` 与 exact closed `reason`;unknown 或带 suffix 的错误统一为 `UNCLASSIFIED`,既有 HTTP response/status 不变。子进程 HTTP/stderr 字节 proof 只属确定性离线工程证据,不构成真实 provider reliability、HotelByte UAT 或 M3/M4/M5/M6 admission。

- **酒店日期输入闸(2026-09-09,issue #283)**:详见 `docs/architecture.md` §1.2 与 §10 D-36。共享 `parseAbsoluteDate` 拒绝非法日历日,酒店消费边界拒缺失日期、溢出和错误顺序,失败不 dispatch 并返回 `input_required`;隔离 fixture 证据不构成真实供应商准入。
- **#270 公开交付与债务台账(2026-09-10)**:所有执行 lane 公开记录 issue 启动、Draft PR、exact-head review 与 merge/destination 回执;founder 授权的仓内 Claude lane 不适用外部机器人 T0/T1 否决,但仍过正常评审。§10.1 活跃债务均有公开 tracker/触发器;本地与 fixture 证明不替代 #20/#22/#136/#137 的真实准入。

- **doctor 对话内自助修复(2026-09-10,issue #284)**:`gotry_doctor action=repair` 按 item id 形成可见计划,经会话 scope 审批后复用 `doctor --fix`/web onboarding 的 bootstrap 幂等安装器并实际复检;拒绝、取消、无审批通道和 user-action/unavailable 均不执行。隔离工具 E2E 只证明 M4 UX 工程边界,不计入 #20 真实 repeat cohort 或 M5/M6 gate。

- **Node 26 dist 构建兼容闸(2026-09-09,issue #265)**:支持下界保持 `>=22.15.0`;根构建脚本用精确 TypeScript 5.9.3 生成 ESM,focused CI 在 Node 22/24/26 核对 exact dist/资产/关键 import,Node 22/24 继续承担 typecheck + 全栈回归。该项仅属 M4 开源/发布质量线,不计入 #20 的真实 repeat-cohort,不满足 #136 的供应协议/内部授权或 #137 的 P6 批准与真实试点；三项真实证据 gate 仍开放。

- **DSH runtime closure 精确迁移 0.1.5-alpha.1(2026-09-09,issue #268)**:root/ts 双 manifest + npm/pnpm 双锁从 `0.1.2-alpha.3`(216 包闭包)精确迁移到 `0.1.5-alpha.1`(230 包闭包:15 新增 sentinel + 移除 `dsh-tool-subagent-report`);全部 230 个 `@deepseek-ai/dsh*` 包钉死精确版本——拒绝 `^0.1.5-alpha.1` 匹配 `0.1.5-alpha.2` 的 semver 预发布漂移;CI `npm ci --strict-peer-deps` / pnpm `--strict-peer-dependencies` 显式严格。run-all §23a-§23e 五个确定性证明（subprocess-local 仅公共 API+进程组信号终止后代 PID 消失、session V3 隔离文件字节迁移、http-proxy 回环 SSE+中毒反例、target-closure root+ts 三层 230 验证）。设置行为不变；历史 `0.1.2-alpha.3` 证据在 §9/stage1/release-notes 旧条目中保留,不批量替换。此项尚未发布 tag 或 npm 版本；这些确定性证明不构成 M5/M6 准入。

- **#290 兼容注(2026-09-09)**:源码与 npm 路径通过 `personaPrefix` / `personaSuffix` 投射产品人格(legacy `persona:` 不投影);桥 handler 结构性归类错误(`timed_out` / `spawn_failed` / `runner_failed`);详见 `docs/architecture.md` §9。不宣称 release/publication、M5/M6 entry、Windows 执行或真实 supplier/HotelByte 准入。

- **dsh-map-tools runtime 回归修复(2026-09-08,issue #242)**:#239 把 settings 接线改到 alpha.3 不存在的 `installSettingsSection/settingsNamespace` 导出,导致真实安装包插件 import 失败；现恢复普通 namespace 字符串 + `ctx.inject(['settings'], scope => scope.settings.installSection(...))`,并由 clean-tarball proof 覆盖 7 个 `map_*` 工具、settings watch/reload/dispose 与禁网 inline 坐标路径。

- **账本 tenant scope 修复(2026-09-08,issue #224)**:ADR-16 的 `tenant_id` 一等字段从 schema/投影约束推进到事件写入、readEvents、fold 与 rebuild 的执行边界;跨租户同 `wish_id`/idem_key 不覆盖,A rebuild 不影响 B/local,跨进程 reopen 可复验。legacy JSON/JSONL 与 v1 DB 只归默认 `local`;已误写成 `local` 的非 local 历史事件不可无证据自动反推,需另行人工 data-repair issue/PR。该修复只闭合本地+Web 一套账本语义,不启封 M6 B2B 插件或 M5 写路径。
- **#254 只读 tenant 修复计划切片(2026-09-10)**:`repair-plan` 仅在临时 db/`-wal`/`-shm` 副本上盘点;源文件在复制或读取期间变化即 fail-closed,隔离测试证明未 checkpoint WAL 可见与 v1 零目录写。该工程切片不执行 apply/迁移/backup/rollback,这些仍是既有 #254 的编号后续子项,不改变 M5/M6 真实证据 gate。

- **政策事实生产端 v1(2026-09-05,issue #141,D-26)**:VISA_POLICY_FETCH effect 注册表行——C 档中国领事服务网(cs.mfa.gov.cn)国家指南树,礼貌抓取(永不重试+断路器护站)→ PolicyFact(as_of+review_by+来源证据链)落账;founder 拍板 C 档免费权威源先行,Timatic/Sherpa° 后议。
- **外部事件接缝设计(2026-09-04,issue #119/#82 兼容方向,D-31 决策点)**:`docs/design/external-event-seam.md`——外部事件作为健康面(站点断→通道态 down,routing/doctor 零改动生效)与愿望池召回的新生产者,消费既有接缝不建新运行时;不做 push/总线/常驻监听;D-31=事件写入信任模型,触发式拍板;落地序列三段(触发式)——第 1 段(本地探针 tick + `'ok'` 恢复事件,channel-probe.ts)与第 2 段(愿望池消费:`conditions.channels`+down 否证召回)已于 2026-09-07 落地(run-all §52/§53);D-31 拍板包已贴 issue #82。
- **账本 CLI 租户解析边界(2026-09-08,issue #226/#241)**:`state-cli` 集中解析 cmd/positional/`--state-root`/`--tenant`/`--limit`,未知/重复/缺值/非法 numeric(含 `.5`/`+.5`)在触碰 state root 前拒绝;`tick`/`export`/`whatif` 明确 local-only,避免默认 local 异步结算、共享 legacy 文件名覆盖或整库 snapshot 被误当租户导出。`--tenant` 仅为账本 scope,不构成认证授权。#241/#243 已入 main并关闭。

- **M4→M6 program 任务图(issue #225,2026-09-08)**:`docs/design/milestone-delivery-plan.md` 记录 M4 scorer(#238)、显式 opt-in lifecycle collector(#248)、tenant ledger/CLI 与 Z3/map 稳定性基座已入 main,#227/#241/#242 已关闭。真实 `observed_private` N≥5 repeat cohort、#136 供应协议/内部授权、#137 P6 founder 批准与真实试点仍为 TODO。`docs/design/write-gate-production-design.md` 是 M5 proposal,不启封交易实现;`docs/milestones/m6-b2b-reuse-walkthrough.md` 仍为待批准草案。
- **Dida 供应商门户会话适配器(2026-09-09,HotelByte portal integration 并行线)**:`gotry_session_search kind=dida` 落地(被动嗅探 SearchRealTime 信封,`referenceNo` 面向服务端预订链);扩展桥 `/jobs` capability 路由防同机旧扩展毒答;CfT HttpOnly cookie 可见性缺陷入 architecture §10 D-37。不动 M5 写路径(WriteGate 红线不变),仅为只读检索面扩容。#308 forward fix:gate/execute 共用 query-first kind 选择,缺省 flight,unknown/malformed fail-closed,train 不绕过 sessionAccess 闸。
- **HotelByte Booking Copilot 产品验收并行线**:GoTry 以单一 `booking.surface` 契约(2026-09-05 #133 收敛,原 v2 形态转正、v1 退役)的 typed read actions 提供协作面——六个生命周期阶段、七个 phase 字面值(`terminal`/`error` 是两种终态结果)的 durable projection,生产 standalone 默认只接受 BFF 已绑定的 `user.turn`/receipt continuation,完整 principal + binding seam 才开放 `user.turn.ingress`,`Book` 留在原 Checkout。Draft 候选已有 exact SHA/schema/Linux Node 24+ABI provenance 与实际进程 health identity/ingress mode;合并 gate 仍是 tenant/customer/storefront/payment-link 四 surface 真实库存、unavailable/changed 恢复链及 Checkout/QueryOrders/清理证据。该线不启封 M5,也不以离线合同或 CI 替代业务验收。
- **效应解译器(2026-08-29,issue #16,ADR-18)**:`effect_interpreter.v1` 落地 L4 渠道边界——指数退避重试 / 断路器 / mock 解译器(纯离线 CI 面)收敛进解译层;五渠道工具 + realtime-pricing 已接,余下渠道增量迁移(D-23)。run-all §37。OTA 工具面照旧平铺,证据链逐源标注不变。
- **通道注册表与健康面(2026-09-03,issue #106/#107/#108,ADR-25)**:检索通道单一数据来源(`channel-registry.ts`)——persona 路由卡 `{{channel_routing_card}}` 与 verdict≠hit 时结果内 `routing` 建议生成化(flyai 达限即改道 session,`hit` 即恢复);会话健康面 + doctor 配额可见(最近达限时间)+ dsh-calendar 默认不挂载(D-9;挂载走 setup 状态面 `npx @danceiny/gotry setup calendar`,不吃 env)。工具面照旧平铺,建议非派发。run-all §50;typed 参数契约迁移余量记 D-30。
- **行为契约横评反哺(2026-09-04,issue #121/#122)**:persona 契约 (1) 扩展同行人到达链访谈(见面/汇合类行程同行人必问:从哪出发/是否已订/有无自己的时间窗,问明落 `gotry_companion_save`,到达账与预算分链核算)+ 新增 (22) 到达账必达(红眼/落地即消耗航段显式给到达账:当地到达时刻含日期偏移/时差/到达精力/前一晚落脚建议)。行为契约 21→22 条,随下个 npm 版本分发;出处为 `docs/evaluation/persona-bench/` 同题横评 G4/G7,founder 拍板。
- **persona 域边界表层规则(2026-09-07,issue #192)**:rc18 真实用户踩坑——模型把 `gotry_motivation_save` 传给宿主 skill 加载器抛 invalid skill name;(16) 内部补表层规则(gotry 能力=工具调用,绝不进 skill 面;skill invalid/unknown 即改回 tool call),契约仍 22 条,persona-surface-guard-tests 3/3 钉回归(run-all §54),随下个 npm 版本分发。
- **澄清卡示例过锚点卡(2026-09-08,issue #2 rc18 复发)**:founder 截图实证——澄清卡把已过的 2026 春节/清明/五一当「想用的时候」候选示例;原 (8) 修复只覆盖推荐链,ask_user_question 卡片示例枚举是模型自由生成绕过锚点卡。(8) 内部澄清补候选时段示例条款(澄清卡/访谈/选项只列今天之后的节日/周末/月份,已过节日不进卡),契约仍 22 条,persona-surface-guard-tests 4/4 钉回归,随下个 npm 版本分发。
- **子任务等待纪律(2026-09-08,issue #194 B-轨道)**:rc19 npm 真实会话——continuable 子代理回执的 durable id(uuid)被模型当 job id 调 `job_output` 撞 `unknown job` 硬错误直达用户;新增 (23) 子任务等待纪律(子代理回执 id 不是 job id,禁对子代理调 job_output/job_kill,完成通知自动送达,追加输入用 send_message)。行为契约 22→23 条,随下个 npm 版本分发;A 轨道(上游 Discussion 报告)留 founder 确认。persona-surface-guard-tests 5/5 钉回归。
- **适配器作者指南(2026-09-04,issue #116,D-13 文档面)**:`docs/design/adapter-authoring-guide.md`——12306 第一方校准法模板化(探测→第一方金标准 fixture→双源 shape gate ≥0.9→漂移锁)+ 文件级接入清单 + 八条纪律红线 + 携程真会话校准清单(执行依赖 founder 登录,挂 gotry-session-data-goal user todo);纯文档,arch §12 文档地图加行。
- **typed 参数契约迁移(2026-09-04,issue #112,D-30,五刀收官)**:全部 23 个注册工具参数面 blob → dsh typed ParameterSchemaSpec 平铺/结构化字段,模型可见逐字段 JSON Schema;刀法总纲:有 required 字段的工具宿主权入口拒畸形参数(ToolFailure 形状不变;evidence P0 红线进 schema),全可选工具保留 interpretArgs 容忍层;迁移锁 smoke §1/§6/§12/channel-registry-tests §8。普通模型 canary(MiniMax-M2.7)10/10 一次成型,**D-30 全面清偿**。
- **工具描述首行生成 + doctor 宿主插件覆盖面(2026-09-04,issue #113,L1 残量收口)**:七个检索工具描述统一前置 channel-registry 生成的「服务意图 × 通道顺位」卡(选工具与失败改道两决策点同表,注册表加行自动一致);doctor 补齐 patch 宿主插件 `dsh-map-tools`/`dsh-tool-ask-user` 两态照亮(此前解析失败整块静默剔除无人知)。source/package 现由 `ts/dsh-runtime/vendor/dsh-map-tools/` 随包交付 MIT payload；因其 peer 要求 `rc.1` 与 alpha.3 closure 冲突,不再作为外部 npm 依赖。
- **启动一次性 doctor 摘要(2026-09-04,issue #114,L2)**:web/headless 启动时分离子进程后台跑只读体检——待处理项一行 stderr、全 ok 静默、零写盘、不阻塞不重复刷、benchmark 面豁免;「初始化时可见」取代「会话中段撞错」。bootstrap-tests §10 钉行为。
- **解译器迁移收尾(2026-09-04,issue #115,D-23 收口)**:anything/web/github/video/agent_reach/session_login 六渠道入效应注册表,23 工具外部依赖面全收敛 effect_interpreter.v1(策略行逐条拍板:timeout 类瞬时重试/配置态与风控类永不重试/反射桥透传零重试);工具面照旧平铺,证据链逐源标注不变;effect-tests §12 钉语义。
- **商店版扩展检测·自适应文案(2026-09-04,issue #117,D-24 清偿)**:needs-extension 文案按本地通道落位自适应——商店版用户不再看到开发者模式/本地通道指引,只推商店一键装与「已装即可」提示;桥失败摘要与 doctor 扩展项同步自适应;extension-tests §38 钉行为。
- **事实闸覆盖面·酒店入闸 + 渲染原语(2026-09-04,issue #118,D-26 收口)**:HotelFact 第三形态(exact-date 酒店检索 hit/miss 落账,flyai/session 两通道接线;摸底不落账、传输失败不落负事实、打码价不落数字价);gotry_fact_gate 酒店 claim 入闸(目的地+档期回溯,无事实 fail-closed);渲染原语单向生成——renderFlightFact/renderHotelFact 行内嵌 fact 锚点,闸侧锚点优先确定性回溯,手改锚点即违例。fact-gate-tests §10(56 pass)。政策生产端(实时签证 API)仍记 D-26 外部依赖。
- **事实闸覆盖面·政策渲染锚点闭合 + 海关申报关键词(2026-09-10,issue #273,D-26 残余收口切片)**:renderPolicyFact 行内嵌 fact 锚点(与机/火/酒店同源 typed-anchor),闸侧锚点确定性回溯,手改/伪造锚点 = fact_anchor_unknown;锚点行 as_of 与事实 as_of 比对(内容指纹),改写或删除日期而保留 fact_id = fact_anchor_unknown;本切片仅核对「截至日期」边界,不宣称封闭 statement 全文或所有事实漂移;POLICY_WORD 补「海关申报」(与「入境申报」同性质但被原 regex 漏掉)——手写政策行缺 as_of → policy_without_as_of。fact-gate-tests §11 八断言(64 pass)。
- **legacy vendored dsh 回退移除(2026-09-04,issue #120,D-27 清偿)**:决策=移除运行时路径——dsh 解析只认 root manifest/依赖闭包,找不到即 fail-closed 报错指重装(旧回退 Node 窗口已断,解析成功只会变玄学失败);inner vendoredDshEarly/legacy-vendored 分支同步移除,DshRuntime.source 收敛 'root';§48 e2e 断言改为「非 benchmark 也不再回退」。vendor 闭包目录不属本清偿范围(锁一致性面另行处置)。
- **可下单事实闸(2026-08-30,issue #46,ADR-19)**:`gotry_bookable_fact.v1` 单一数据源 + 产物事实闸——flyai/session exact-date 检索结果 hit/miss 逐条落账(query_id 可重放),**exact-date miss 禁止用历史班期/相邻日期/航线页回填**;`gotry_fact_gate` 交付前必过(claim 反向抽取回溯 + 夜数/O&D/预算不变式),blocked 不得宣称「已验证方案」;persona (20) 红线化。run-all §39 locked golden 2027 E2E + smoke §16。覆盖面缺口记 D-26。
- **npm 形态自定义端点修复(2026-08-30,issue #48)**:bin env 映射补 `LLM_BASE_URL → DEEPSEEK_BASE_URL`——rc.15 回拉实测暴露只映射 key 不映射 base,OpenAI 兼容端点 key 被发往 DeepSeek 官方端点必然 401。修复后三件套 `.env`(`LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL`)即全链通;显式 `DEEPSEEK_BASE_URL` 仍优先,默认官方路径零改变。dsh 侧(llm-deepseek)与仓内 `dsh-llm.ts` 拼接语义核验一致(`${base}/chat/completions`)。README 双语 + `.env.example` + bin help 同步。
- **价表 v2 + 价格漂移长机制(2026-08-30,issue #49,ADR-20)**:
  - 封存价表 v1(DeepSeek V4 only)升 v2(provider-aware,`gotry_llm_price_table_v2`);MiniMax M2/M2.1/M3 入表;`ts/scripts/price-drift-watch.ts` 覆盖四家主流 provider,默认离线对照 baseline 比对输出 PR-就绪 Markdown diff,**永不自动 apply 价格**(ADR-11 纪律——founder 实测「自动 apply 易把官方 down 5% 误认为我的 bug」)。fetch/解析失败 → SKIP + reason,零写未知数据。
  - run-all §41 合同验证 8/8。同批 CHANGELOG 机制(`ts/scripts/build-changelog.ts` + `CHANGELOG.md`,`publish-npm.sh` 闸自动跑 + `gh release create`)与 §38 扩展桥 zombie port 根治。

### M4/M6 本地基线稳定性(#227)

- **Z3 WASM 生命周期复修已接入回归闸**:Node24 全栈 §30 间歇 heap corruption 的新增修复面为冷初始化 Promise 先缓存 + `z3-solver@5.2.0` low-level native cleanup 局部队列 + actual native check barrier + fatal poison。确定性守卫进入 run-all §30b,多进程重复进入 §30c；长稳证据仍按 PR/本地执行报告逐 SHA 给出,不得用单次 scratch 绿替代。

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

- **ChinaTravel grounding-v3 canary**:首例可评分终态通过,第二例 planner 重复工具循环超 300s;当前只允许报告 `attempted=2/scored=1/timeout=1`,不得外推 5-query aggregate。
- **Round 1(工具预算)**:每轮第 16 次注入收敛上下文、第 18 次最后 body、第 19 次起 `TOOL_BUDGET_EXHAUSTED`;run-all §45 覆盖离线 E2E,CI 以当前 SHA tarball 隔离 consumer 重放。**后续(ADR-24 v2)**:真实轨迹证明任何「到点杀 turn」都会复现同一失败,最终形态=「路由 + wall-clock 双出口」(确定性分类 quick/sync/deep;deep 硬阈落 handoff 工单并告知 ETA;收集闭环 `turn-handoff-collect.ts` + 只读复访工具 `gotry_turn_handoff_list`);设计全文见 `architecture.md` §8.24。
- **Round 2–9(Phase 1 bridge)**:Round 2–8 frozen treatment 均为 diagnostic-only、official scores null、不声称 uplift；Round 9 通过模型输出上限、可配置预算与 paired-think normalization 让治理链路首次存活，但仍没有可归因 official score。逐轮合同与结果见 `evaluation/benchmark-environment-bridge.md` 的 Round ledger；演进摘记见 `architecture.md` §9。
- **Round 10(per-tool typed result contract)**:保留单一 flat `tools|call|errors` 协议，以 owner-local descriptor 同源生成每工具 exact call schema 与 spawn 前 validator；强制非空 output key、有限 exact domain tuple、严格 result/domain/failure envelope，并以最新 bridge response 钉住 terminal 时序。该轮不改 provider/scorer/evaluator/default product path；冻结 treatment 与 score 仍须独立 evidence，未取得前禁止 uplift 声明。
- **Round 10 real treatment / Round 11 wire slice**:main `c843fae` 上的 `glm-5.3-flash` treatment 诊断为 provider/model visibility failure：顶层 `oneOf` 导致 57 次空 `{}` 调用，无 countable score。Round 11 仅将模型面对的 bridge wire 改为 flat `action=tools|call|errors`、descriptor-derived `tool` enum 与 generic object `arguments`；执行时仍 exact 校验冻结 descriptor `input_schema`。不改变 provider/scorer/evaluator/default product path，不声称 score/uplift。
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
| v0.0.1-rc.7 | 已发 npm;rc tag 曾滞留本版至 2026-09-02(#50② 已迁至 rc.16) | .env 读用户当前目录 + 无 key 可执行指引 |
| v0.0.1-rc.8 | 已发 npm(曾直指 latest) | `npx @danceiny/gotry` 即得;干净安装 headless 实测跑通 |
| v0.0.1-rc.9 | 已发 npm(曾为 latest;**含缺陷:better-sqlite3 未入 dependencies,装得上跑不起**——被发布后干净安装验证抓出) | M4 记忆域全链/账本/17 工具/D-6 校准 |
| **v0.0.1-rc.10** | 已发 npm(曾为 latest;registry 回拉实测:489 包安装/插件加载/bin 全通) | 双形态冻结 ADR-16 + 会话传输层 puppeteer 定案 + 依赖面根治;rc.9 标缺陷由本版覆盖后退役 |
| **v0.0.1-rc.11** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/插件加载/bin 全通) | 已知限制清算:Z3 WASM race 根治(D-17)+ 实时票价桥(flyai overlay)+ i18n 英文面(工程层)+ 薄壳删除;run-all 新增 §30-§32 |
| **v0.0.1-rc.12** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/插件加载/bin 全通) | OTA 扁平化(flyai kind=hotel 酒店接入)+ 账号会话授权闸 v2(每会话一次/拒绝吊销/sessionAccess 总闸)+ 登录产品化(`gotry_session_login`,第 18 工具,零终端零凭证)+ dsh vendored alpha.1 + issue #24 三处修复 |
| **v0.0.1-rc.13** | **已发 npm,latest 直指本版**(registry 回拉实测通过) | 账号会话三连修复:登录自动检测(已登录零弹窗)+ 登录页置前可见性(`newPage` 纪律)+ 例行测试永不自动开窗;README 可读性一版(18 工具分组/账号会话隐私专节/状态重排) |
| **v0.0.1-rc.14** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/bin/npm 页英文 README) | 文档中英分开发布:`README.md`(英文,完整镜像)+ `README.zh-CN.md`(中文)互链,顶层 switcher;npm files 增补中文版 |
| **v0.0.1-rc.15** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/bin/插件加载全通) | issue #17 采纳:预订 saga 状态机具名化 `booking_saga_fsm.v1`(ADR-17,纯函数词汇层+§36 与账本物理对账)+ HITL 审批边/合规确定性边词汇;run-all 新增 §36 |
| **v0.0.1-rc.16** | **已发 npm**(2026-08-30T13:00Z 补发落地;2026-09-02 回拉实测干净安装/bin 全通,#50② 同窗完成 dist-tag 治理) | issue #49 采纳:价表 provider-aware v2 + MiniMax 入表(ADR-20)+ 价格漂移监测长机制 + CHANGELOG 机制 + §38 扩展桥 zombie port 根治;run-all §41/§42 两闸。详见上方「架构面增量」 |
| **v0.0.1-rc.17** | **已发 npm**(2026-09-02) | Session Bridge Chrome Web Store 上架(D-25 清偿):一键装 + 自动更新;扩展安装职责返交浏览器(needs-extension 返 installUrl 可点链接,dsh UI 渲染);商店版/本地版双通道同信互通 |
| **v0.0.1-rc.18** | **已发 npm,latest 直指本版**(2026-09-03 回拉实测:559 包干净安装/bin/dist 入口全通) | CLI 层「更像个插件」:缺 LLM key 不再 CLI 挡路(静默委托 dsh);`gotry setup` 收窄为只管扩展检查(不再代装 hbcli/agent-reach/sidebar);README 双语 + user-guide 卸 key 引导 |
| dev(未发) | 持续 main 直推 | 迪拜 session 复盘修复(defeb5b:doctor 体检面/flyai 429 needs-setup)+ 会话面机/酒/火三通道收官(da6c138/5cf1e4a/7b31ad5)+ ADR-24 v2 turn 双出口与 handoff 收集闭环(PR #109) |
| 后续 | founder 侧 | 种子用户邀约;**v0.0.1 正式版拍板**(去 -rc 后缀,发布闸五件见 AGENTS.md);rc.16 补发 + dist-tag 卫生已结(#50②③,杂散别名删除需 npmjs web UI) |

**M3 工程面已推进但 Exit 未关闭；M4 自 2026-08-26 起由 founder 授权并行推进，不是 M3 Exit 证明。** M4 记忆域 T1 行为链已闭合（动态吸收→读回→效用→触达→度量），六层重设计已落地 `memory-design.md`，分期增量为 P1 旅行时间线→P2 同行人档案→P3 时间窗衰减→P4 双区会话后置；#228 collector 只提供显式 consent/stateRoot/HMAC 的 planning lifecycle 脱敏采集,不代表真实 repeat cohort。
  - **2026-08-28 会话数据面并行线(RFC `user-session-data-rfc.md`,loopx goal `gotry-session-data-goal`)**:P0 官方通道尽调(飞猪 FlyAI 无 key 只读,机/火检索官方主链路)+ P1 会话骨架(ReadGuard 物理只读/携程 batchSearch 嗅探/节律闸,登录态=存在前提)+ P2 action-cache 自愈层/美团骨架(a11y 兜底,匿名 403 实测)/金标准 20 查询/**#21 字段 fixture scorer+双源合同+waiting-attach no-spend 已落** + P3 工具面两工具(smoke §12,当时 17 工具)——与 M4 记忆域正交推进;
  - 待用户日常 Chrome 完成 remote debugging、权限确认和 CDP 握手后收尾真实 sf-01..08 双源跑批/真模型巡检。
  - **2026-08-28 事务化状态基座落地(ADR-15,RFC `transactional-state-rfc.md` accepted「按你的建议来」)**:
    - 「文件即权威」升级为「单文件 SQLite 账本即权威」——
    - events append-only + 投影 fold 重建 + 红线(evidence/conditions)进事务 + confirm-outcome 单事务 + 异步工单 durable 恢复(exactly-once；`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0，将非 4/4 映射为 `failed`/ledger `failed`/exit 2，终态复诵零重算且保持同一退出码)+ pending_writes saga(WriteGate M5 的 L2/L3 基座,D4 定为 M5 Entry 前置);
  - 旧 JSON/JSONL 降级为单向导出视图(红线 6),首写自动迁移+快照;run-all §28/§29,多用户账本化(RFC §6.5)触发式后置(D-15)。**同日 ADR-16 双形态架构冻结**:本地+Web 一套账本语义、tenant_id 一等字段(schema v2)、同步=事件复制非状态翻译——防「将来大规模重构」的核心冻结,founder 拍板「要的」。
  - **2026-08-29 已知限制清算第一刀(founder 指令「解决这些 known limitations」)**:Z3 WASM race 首轮收敛为 `z3-shared.ts` 单一实例+会话级互斥(run-all §1 重试止血退役+§30 并发回归闸),薄壳遗留(`shell/`)物理删除——README Known limitations 中两条就此清偿。**2026-09-08 #227 复修**:Node24 暴露 high-level FinalizationRegistry native cleanup 越过互斥与冷初始化缓存竞态,补 low-level cleanup 队列/actual native barrier/fatal poison 并进 run-all §30b/§30c。余两条同批推进:实时票价桥已接入(flyai overlay+env 闸,run-all §31),i18n 工程面落地(run-all §32:en 零缺键/zh 金标准逐字节),人格与工具卡的校准后补齐挂 M4。
  - **2026-08-30 会话传输层定案扩展桥(issue #21 方案 C,founder「逐连接权限框根本无法使用」实测定案)**:Chrome 144+ 每 CDP 连接必弹权限框且无持久化批准 → CDP 降显式 opt-in,自研 `extension/` GoTry Session Bridge(MV3 一次性安装,固定 key 扩展 ID)+ `node:http` 回环桥升 PRIMARY——系统弹窗每会话 0 次;登录快路径免标签页秒回;`needs-extension`=waiting no-spend;run-all §38 全离线 23 断言;真实 sf-01..08 双源跑批门禁降为「装一次扩展」,与 #16/#22 同属等外部输入的 no-spend 等待面。
  - **2026-08-30 同批 onboarding UX(issue #21 P3.6,后于 2026-09-02 商店上架后撤销)**:5 步 GUI 编排 wizard 曾把用户侧降到 3 次点击;商店上架后按「职责返交」撤销——安装回浏览器、渲染回 dsh UI,wizard 退化为离线健康探活等待(run-all §40;全文见 `rfc/user-session-data-rfc.md` §3.3)。
  - **2026-08-30 同批 P3.7 双源 e2e 真跑批(goal 2,commit `60669f8`+PR #66 follow-up)**:founder 实问「flyai 只是一个 vendor,可以切别的?」→ **拒 vendor 锁**,official golden 改 pluggable(默认 `manual-golden`;`--golden=flyai` 显式切);`ts/scripts/sf-live-benchmark.ts` + `ts/scripts/sf-summary.ts` 重建 unified summary;
  - 本机实测 8 query:**7/8 verdict=hit / 6/6 manual-golden 软命中 100% / live <15s 7/7 / ReadGuard 0**;issue #21 验收清单「sf-01..08 完成真实双源 e2e + 字段准确率 ≥90% + live <15s」**全数达成**;evidence 落 `~/.gotry/evidence/session/sf-XX/<ts>.json` + sf-summary。后续 goal 3 vendor 接入由 founder 决定(hbcli / 携程开放 API / 内部 static 包兜底)。
  - **2026-08-30 同批扩展分发双通道(issue #21 分发通道,ADR-21)**:founder 指令「产物下载和安装也得做成更好的用户体验,可以用 github 作为分发渠道」——Chrome 平台约束(GitHub 只能改善下载,一键装+自动更新只有 Chrome Web Store)下双通道:GitHub Releases 下载通道已落(`gotry setup --extension-from=github` 显式 opt-in,稳定资产名三件套 + SHA256 + key 钉扎 + 失败显式降级 bundled,扩展更新与 npm rc 发版火车解耦;`scripts/package-extension.mjs` 只产产物,上传走发布确认制);run-all §43 + bootstrap-tests 8/8。
  - **2026-09-02 Web Store 过审上架(D-25 清偿)**:[GoTry Session Bridge 商店页](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) v0.1.0 发布,一键装 + 自动更新通道打通,升为推荐安装方式。上架实测:商店用自己签名 key 重签、不认 manifest 固定 key,商店版扩展 ID(`oeajpiccmonococjcegddlooeeohlbgd`)与 unpacked 固定 ID 不同——桥 Origin 白名单双通道同信(`EXTENSION_ORIGINS`,run-all §38 新增商店源断言);GitHub Releases 通道保留为免审核/更新更快面;Node 侧保留 extension 文件/`manifest.key` 预检,`needs-extension` 的 `installUrl`/`installAction` 交 dsh UI,旧 wizard 不再承担安装职责;#117 自适应文案已清偿 D-24。

**M4 Issue #20/#223/#228 证据切片(2026-08-29;2026-09-08 加固与 collector)**:paired cohort 合同与只读 synthetic fixture scorer 已落地,固定唯一匿名 subject、returning 晚于 first、active planning duration 扣除预声明 external waits、N/p50/p75/逐 pair reduction、experience reflux、偏好溯源/硬过滤红线与 P4 trigger 闸。#223 将 public fixture 扩成指标正例 N=5,冻结 `minimum_pair_count_for_exit=5` 与 `target_median_reduction_ratio=0.5`(raw ratio 比较,报告才 round),并要求逐层 exact schema、HMAC-SHA256 假名键、source-review attestation 合同与 `reviewed_summary_digest_sha256` 绑定。#228 collector 追加显式 opt-in CLI/纯逻辑模块:隔离 `stateRoot`、consent/HMAC 必需、source/wait/key 冻结、写前完整投影校验、JSONL+manifest write-all/原子发布/realpath 隔离,导出仅 candidate/synthetic。synthetic 仍 `exit_evidence_eligible=false`,observed-private 缺人工核验合同或 digest 不匹配时也只可作为 candidate。当前瓶颈是私有真实 `observed_private` N≥5 repeat cohort,无样本时 waiting/backoff/no-spend。

**2026-09-09 issue #258/#267 web 启动交互式 onboarding(M4 UX 工程面,非 #20 Exit 证据;#267 = #266 合并后的 post-merge 加固)**:`npx @danceiny/gotry web` 启动前的显式可选能力配置(每次符合条件的启动评估一次、至多问一次,无跨启动持久确认),复用 `doctor --fix` 幂等安装器(不建第二套);仅交互式 TTY + 有 auto 缺项时问一次,三态结果(installed/needs-user-action/unavailable);无 auto 但有 reportable 缺项(如 win32 平台不支持自动安装)时渲染分类计划 + 具体原因、不 prompt 不安装、`reported` 抑制重复 detached 摘要;CI/非 TTY/全健康/opt-out 零 prompt 零安装仍启 web。`installerEnabled` 注入 env,纯函数全链不依赖 ambient `GOTRY_SETUP_*`。#267 加固:web-onboarding 子调用改 awaited POSIX process-group `spawn`(JS 可服务 SIGINT/SIGTERM,信号路径清 result+patch 目录),bootstrap installer `run()` 同步进 bounded process-group lifecycle;outer grace 显式覆盖 installer TERM+SIGKILL budget。结果通道改 0700 `mkdtemp` + `0600/wx` 排他写入;落地 `bin/gotry-{inner,bootstrap}.js` + bootstrap-tests §21 跨过真实 inner→bootstrap onboarding 进程边界(观察到 prompt),§21c prompt-wait SIGTERM 清理,§21f accepted-install parent SIGTERM 清 stubborn installer,§21g accepted-install onboarding timeout 清 installer 并继续 web(D-34 清偿)。**这是 M4 UX 质量线,不计入 #20 真实 `observed_private` cohort Exit 证据**,fixture/隔离单测明确排除在 M4 Exit attestation 之外。

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
| M4 | 记忆与「下一次出发」 | 六层 memory 的 C 端域实现;wish pool 联动回访;#228 lifecycle collector | 北极星(下一次出发率)开始度量;对账七题=首批校准 | 订阅形态验证(¥49/年锚) | **founder 授权并行，非 M3 Exit**（#20/#223 scorer + #228 collector 为工程证据面；真实 `observed_private` N≥5 + source-review 待） |
| M5 | 交易闭环 | WriteGate 上生产;预订/支付/退改 | 佣金披露上线;红线随行 | 三层收入全开(免费/Plus/佣金) | 未来，仅受 M5 Entry gate 开闸 |
| M6 | B2B 包裹 | traveler principal/sponsor 插件化,内核零改动跑通旅行社嵌入 | 两层为什么实证 | 复用率从论断变为带基准 SHA/分母/加载覆盖的实测;B2B 试点 | 未来，仅受 M6 Entry gate 开闸 |

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
- **Entry**:正式里程碑 Entry 仍是 M3 exit；当前仅由 founder 授权并行工程切片，不改变 M3 Exit 判定。**交付**:C 端记忆域(六层框架重设计)、主动回访(可关闭)、北极星开始度量;对账七题答案=红眼模型与偏好的首批校准样本。Issue #20/#223/#238 scorer 已加严,#228/#248 collector 只提供显式同意的 lifecycle 采集与 candidate/synthetic 导出,不得用历史 wish 日志或 candidate 采样器推真实 cohort;真实 `observed_private` N≥5 repeat cohort + 人工 source-review attestation 仍是 M4 Exit 前置。任务图见 `design/milestone-delivery-plan.md`。
- **Exit**:回访用户规划时长较首访降 ≥50%;经验回流率有基线。

### M5:交易闭环
- **Entry**:M4 exit + 供应链协议。首供应链为 `hotelbyte-cli`(公开 MIT CLI;hotel-be 内部资产只 bridge/reference,不复制代码);当前未取得供应协议签署/内部授权证据,仅进行只读接口调查与契约准备。**交付**:WriteGate 生产化——写权按 L0-L4 渐进授权(L2 建议/L3 具名 seam 确认带 receipt/L4 自动类),每级可回滚(RFC S4);预订/支付/退改;佣金披露(红线随行)。**设计基座已备(2026-08-29,issue #17 采纳/ADR-17)**:预订 saga 状态机词汇层(`booking_saga_fsm.v1`,`ts/src/booking-saga.ts` + `docs/design/booking-saga-fsm.md`)——字母表/四条边全函数边表/拒绝闭集/审计链校验,run-all §36 与账本物理对账。生产化 proposal 见 `design/write-gate-production-design.md`:可信 receipt 发行/消费权威、request fingerprint、approval_claims 持久化、本地 outbox intent(不宣称外部 exactly-once)、HotelByte 30s/unknown/query miss/对账/补偿/披露矩阵。启封时任何 booking seam 只许走该边表;空 receipt 物理 CHECK、seam 命名词汇、L2/L4 接线与审批等待态为 M5 交付物;实现 issue #231/#232/#233。
- **Exit**:预订零误操作事故;单位经济实测(对齐 D1 §8)。

### M6:B2B 包裹
- **Entry**:M5 exit + P6 founder 明确批准。P6 draft 见 `milestones/m6-b2b-reuse-walkthrough.md`,当前尚未获批准;P6 批准不等于 M6 Entry,M5 Exit 仍是硬前置。tenant ledger/CLI 与 Z3/map 稳定性基座已入 main,#227/#241/#242 已关闭。**交付**:traveler principal/sponsor/BFF 三主体隔离与插件披露,一个旅行社主场景(目的地文旅为辅)在固定冻结 `kernel-set` 零 diff 下跑通;runtime 实际加载 coverage 与预声明功能路径 coverage 分开证明,loaded LOC ratio 仅作附属指标;实现 issue #234/#235。
- **Exit**:工程半面为固定 `kernel-set` diff=0、runtime 实际加载 coverage、预声明功能路径 coverage 与旅行社嵌入 E2E;商业半面必须有真实 B2B 试点签约。未签原因只能解释整体仍为 TODO,不能替代签约。

## 最短路径:现在 → M3 exit

```
你:remote 目标 + License 两个决策      ← 发布闸④⑤,种子用户的前置(发布 owner 等这两个答案)
你:种子用户邀请(发起人即首个用户)      ← ./gotry 即入口(v0.0.1-rc2)
工程:D-7 迁移(候选形态进 TS unified,清除洱海路由 hack)→ 指标面板(ADR-11 质量层)(第一切片 2026-09-05 已落地:只读聚合呈现面 v1,#138;持续观测/可视化待后续切片)
Round 9(2026-09-06):治理面预算可配 + LLM_MODEL 输出上限钉死;治疗首次全链路存活(#100/#102)
```

## 旧模型映射(归并即退役)

| 旧模型 | 位置 | 映射 |
|---|---|---|
| 技术 Stage 0/1/2/3/4 | architecture.md §9 | M0 / M1 / M2 / M4 / M6(M3/M5 是产品/商业交汇点,技术线横跨) |
| 总纲 Phase 0/1/2/3 | gotry-master-outline.md §5.1 | M0-M1 / M1-M3 / M3-M5 / M5-M6 |
| 产品 M1/M2/M3 | gotry-product-design.md §10 | M3 / M4 / M5 |

## 修订史
归 git(本文不设版本号)。
