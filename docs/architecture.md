# GoTry 技术文档(唯一技术权威面)

> 定位:本仓的**完整技术文档**——系统是什么、怎么构成的、每个模块在哪、怎么跑、往哪演进。
> 纪律:单一文件承载单一关注点,版本历史归 git,不设 vN 文件后缀;上游为总纲(`gotry-master-outline.md`)与产品设计(`gotry-product-design.md`)。
> 下游:loopx todos 依本文§9 演进阶段与§10 债务清单派生;引擎/求解器细节工作只在债务清单标注时进行。

---

## 1. 系统是什么

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**:动机访谈进、已验证的行程方案与选择题出;LLM 负责理解与解释,确定性组件负责判定与算术,写操作永远有闸。

**当前形态(诚实定位,2026-08-29 `v0.0.1-rc.12`)**:dsh 成品可用(`./gotry` 或 `npx @danceiny/gotry@rc web`,DeepSeek 原生)——人格(行为契约 18 条,锚点卡/记忆 brief 注入 persona,运行时组合唯一来源=仓根 cordis.gotry-patch.yml——2026-08-28 发现 ts/ 副本分叉致产品面跑旧人格,当日归一退役副本)+ 十八工具(可行性/骨架/酒店/天气/航班/Anything/网页/视频字幕/GitHub搜索/AgentReach wrapper/动机/愿望池/愿望召回/旅行时间线/同行人/**飞猪官方检索/会话检索/账号登录**——2026-08-29 OTA 平铺与账号授权闸:gotry_flyai_search 扩 kind=hotel(飞猪 search-hotel 实测接入,未鉴权打码价保 priceRaw 原值不伪装数字价),persona (19) 删「三级路由」改平铺工具面(无预设路由优先级,证据链逐源标注不变);账号会话工具授权闸进代码——`tools/pre-execute` 监听器(`session-consent.ts`)**每会话每站点首次调用**经 dsh 原生 ApprovalService 审批卡请求授权(allowed-once 记入会话 granted 集,会话内后续调用免弹;**用户拒绝 = 本会话吊销**,不再弹卡也不再执行——founder 实测「每次都弹,经常无法点击」后由逐次批准改会话内一次;无审批通道/headless 一律 fail-closed 拒绝),插件 config `sessionAccess: ask|allow|off`(随时可关/明示预授权/总闸关闭)(RFC 支柱④「用户明示授权+站点白名单+随时可关」进代码,founder 口径「OTA 都是工具;用用户账号必须确认」);**登录产品化(第 20 工具 `gotry_session_login`,能力层 `capabilities/session-login.ts`)**:needs-login 时 agent 直调——在用户 Chrome 弹登录入口、等其在携程官网完成登录,无需终端;gotry 只读票据 cookie 名零值过手(登录永远在外部网站完成);登录引导页不挂 ReadGuard 为唯一豁免面(检索面不变量不变,`transport guard:false`);遗留 CLI `scripts/session-login.ts` 降薄壳;**测试不再自动开浏览器窗口**(session-tests G 节 live 改 GOTRY_SESSION_LIVE=1 显式 opt-in——founder 反馈「在匿名窗口反复打开携程/界面闪退」= 测试骚扰,当批根治),smoke §12-13 + session-tests §G/H/I + run-all §24);机票三层(骨架 168 对+校验桥+锚点)+ 酒店 hbcli 桥(实时/静态降级+证据标注;**M0 预订链读工具(2026-08-30,NL booking PRD hotel-be docs/products/gotry-a2a-nl-booking-prd.md)**:第 22/23 工具 `gotry_hotel_rates`/`gotry_check_avail`——HBCLI_HOTEL_RATES/HBCLI_CHECK_AVAIL 效应工具面接线,rates 建 backend session 产出 ratePkgId、check-avail 以下单前实时复核为责;**价格面 fail-closed 红线**:无静态降级、不可用即诚实失败不估算房价(ADR-19 事实闸同口径),断路拒绝走平铺失败面;smoke §5 注册+fail-closed 断言、effect §10;**M1 预订写效应与确认门(2026-08-30)**:`HBCLI_TRADE_BOOK` 入注册表(写效应首例)——`capabilities/booking-write.ts` saga 编排(requestPendingWrite 幂等键=customerReferenceNo→通道→confirm 携订单回执/compensate,重复提议物理 no-op);第 24 工具 `gotry_book` 确认门(WriteGate 红线落码:confirmed!==true 只出确认卡零通道触达,卡含幂等键与「金额以后端为准」声明);永不重试(双订风险),effect §11 伪通道四断言+smoke 门三断言;**headless 一句话冒烟与兼容修复(2026-08-30,同 PR)**:`GOTRY_STATE_ROOT` 状态隔离开关+`GOTRY_NO_CALENDAR` 可选插件剔除(bin/gotry-inner.js patch 生成期注入);opt-in 脚本 `ts/scripts/nl-quote-smoke.ts`(真 LLM 一句话→报价卡/访谈追问,缺 key 或鉴权失败 SKIP,不进 run-all);Node 24 strip-only 模式参数属性兼容(resilience.ts/action-cache.ts constructor 去语法糖——dsh 经 Node 原生 strip 加载 .ts 插件,参数属性直接 SyntaxError);**2026-08-30 全流程 E2E 收口**:本机官方脚本装 staicli → hotel-be 种子沙箱账号取票 → UAT 通道/鉴权/搜索编排真通(供应商 provenance 实证),UAT 库存暂空走设计内静态包降级,run-all §7d 固化、无 bin/无网 SKIP)+ Anything 通用搜索(gotry anything.ts;实时链 2026-08-25 终局撤回——hotel-be @path 免鉴权面按 founder 判定无附加值,两 PR 关闭,静态包兜底;酒店域实时改走已注解的 hotel-list 面);OpenSky 实时 ADS-B + Open-Meteo 天气免费接入;**agent-reach wrapper 化**(上游 v1.5.0 装于 .venv;反射桥 agent-reach-bridge.py 直调上游注册表,零渠道知识,needs-setup 透传上游 check() 原话;真 LLM 会话复验 e2e-prompts §7/§8);**License MIT**;**npm 公开分发已通且 latest 直指 rc.15**(`@danceiny/gotry@0.0.1-rc.15` 2026-08-29 发布:issue #17 采纳——预订 saga 状态机具名化 booking_saga_fsm.v1(ADR-17,run-all §36 与账本物理对账);历史 rc.14 2026-08-29 发布:文档中英分文件(README.md 英文 + README.zh-CN.md 中文互链);历史 rc.13 2026-08-29 发布:账号会话三连修复(登录自动检测/登录页置前/标签页纪律)+ README 可读性一版;历史 rc.12 2026-08-29 发布:OTA 扁平化/账号授权闸 v2/登录产品化第 20 工具 2026-08-29 发布:OTA 扁平化/账号授权闸 v2/登录产品化第 20 工具 2026-08-29 发布:已知限制清算——Z3 race 根治 D-17/实时票价桥/i18n 英文面/薄壳删除;run-all §30-§32 固化;founder 确认制下 agent 执行,registry 回拉实测过;历史:rc.10 2026-08-28=双形态冻结/传输层 puppeteer 定案/依赖面根治,曾为 latest;rc.9 已发包缺陷=dist 带账本但缺 better-sqlite3 声明,装得上跑不起,由 rc.10 覆盖);工具 execute 统一 guardToolExecute 异常隔离(D-NEW gotry 侧收尾)+ 平铺观察 envelope(ADR-13);py 树仅剩 gotry_feasibility oracle(D-7 清偿);run-all-tests 全栈回归全绿(套件清单见 `scripts/run-all-tests.sh` 分节,计数不落字)。M3 最小可用产品,分发链路无已知堵点。**时间感知硬化(2026-08-27,时间评测驱动)**:确定性时间锚点层 `ts/src/time-anchor.ts`(今天/明天后天大后天/本周下周下下周/下个月分段/季度/节日锚点,纯函数;注入 persona `{{time_anchor_card}}` 与 legacy 抽取全链路——此前 FACTS/SKELETON 无时间注入,过期语义无从谈起);`ts/src/travel-slots.ts` 差旅槽位抽取(travel_slot_extraction.v1:时间表达逐字保留,过期判定与 language 检测归代码层);`ts/src/slot-spec.ts` 槽位→日期解析层(锚点卡词表换算+spec 一致性闸,D-10 三切片清偿);评测基建 `data/time-slot-eval.json`(25 题)+ `ts/scripts/time-eval-tests.ts`(确定性部分进 CI;真模型巡检基线 11/25 → 25/25,P0 8/8);顺带清偿 dsh-llm 环境变量模块顶冻结致 .env 不生效的存量隐患(改调用时惰性读取)。**M4 记忆效用 sidecar(2026-08-27,RFC S2/S3)**:`ts/src/memory-utility.ts`(recalled/applied/verified_outcome 三类事件 + 归因只认 owner 确认,模型不许自评「有用」)+ wish 稳定 wish_id/muted + `gotry_wish_pool_list`(0..1 条件召回,muted 不召回,北极星「下一次出发率」的度量底座)。**记忆读回(T1 写读闭环,2026-08-28)**:画像此前只写不读,新会话模型盲访——`{{motivation_brief}}` persona 变量把 motivation-profile 渲染成紧凑 brief 注入(空=首访,契约 (1) 据此分支;回访不重复问已答字段,冲突以用户当轮为准)——M4 exit「回访规划时长降 ≥50%」的机制前提。**记忆域 P3 时间窗衰减落地(2026-08-28)**:`memory-decay.ts` 分级窗口原语(只降不删/地板 0.1/动机零衰减构造性保证)+ memory-metrics 新鲜置信度列——行为记忆按 30/90/180/365d 分级新鲜度参与投影。**记忆域 P2 同行人档案落地(2026-08-28)**:`companions.ts` + `gotry_companion_save`(15 工具)+ brief 同行人行——P1/P2 连续落地(memory-design §4)。**记忆域 P1 时间线落地(2026-08-28)**:`travel-timeline.ts` + `gotry_trip_log`(第 14 工具)+ confirm-outcome 自动挂时间线 + brief「去过」行——M4 分期 P1 完成(memory-design §4)。**记忆域正式设计(2026-08-28)**:`memory-design.md` 落地 M4 交付「六层框架重设计」——六层(M1 用户基础/M2 动机偏好/M3 预算/M4 时间线/M5 同行人/M6 双区会话)现状映射 + 分期增量(P1 旅行时间线→P2 同行人档案→P3 时间窗衰减→P4 双区会话后置)+ 铁律(溯源 P0/排序不硬过滤/负面清单/多用户前向兼容)。**北极星过程面度量(2026-08-28)**:`scripts/memory-metrics.ts` 只读投影(wish 在册/休眠、效用事件计数、经验回流率基线 verified/recalled,run-all-tests §20)——M4 exit「经验回流率有基线」的工具前提。**主动回访骨架(2026-08-28)**:`scripts/nudge-digest.ts`(0..1 条件匹配经 `wish-pool.ts` 纯函数,三通道 stdout/file/lark——lark 等 GOTRY_LARK_WEBHOOK 配置即插即用,投递失败降级 stdout 不阻塞;`GOTRY_NUDGE_ENABLED=false` 全局关闭,契约「可关闭」,run-all §21)。**真模型巡检轮(2026-08-28,ADR-11 巡检层)**:persona 扩三处(motivation_brief/0..1/归因禁令)+13 工具后全量巡检——time-eval --real 25/25(P0 8/8)保持;replay-real 抓出 D-10 闸多段误伤并当日收窄修复(见 D-10),修复后真模型多段行程全链求解恢复;同轮暴露 probePoi 三类误触发(短句直通把访谈答案整句当关键词/订酒店抓「我订了」/多段首查抓「机票和」),当日收紧——关键词方向性(动词宾语后置、住宿名词后段优先、短裸地名 ≤12 字加陈述动词闸),probe-poi §7 金标准噪音回归,订酒店改抓真实名称段(The Title…)。**会话数据面 P1(2026-08-28,RFC `user-session-data-rfc.md` G7 立项)**:官方通道 `capabilities/flyai.ts`(飞猪 FlyAI 无 key 只读,机/火车票;spawn CLI 管道,agent-reach 同构)+ 会话面 `capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}`(puppeteer-core 专用 profile;ReadGuard 方法×URL 双因子写拦截+审计+fail-closed;携程 batchSearch 嗅探;节律闸 ≥30s;证据链 `[会话:ctrip-flight@ts]`;live 需 headful);run-all §24,session-tests 25 断言。工具面接线在 P3。**事务化状态基座(2026-08-28,ADR-15,RFC `transactional-state-rfc.md` accepted)**:「文件即权威」升级为「单文件 SQLite 账本即权威」(`ts/src/state-ledger.ts`,better-sqlite3/WAL):events append-only 唯一权威(语义幂等键 UNIQUE 物理化,wish_id 改语义派生)+ 投影表可 fold 重建(mergeProfile/appendTrip/upsertCompanion 守门纯函数原样复用为写路径与 fold 处理器,语义层零改造)+ 红线(evidence/conditions)进事务、拒绝即回滚 + confirm-outcome 单事务(效用+行程同生,跨文件分叉物理不可能)+ 异步工单 durable 恢复(workflow_steps intent-before-execute,崩溃后 done 步骤零重执行,exactly-once)+ pending_writes saga(WriteGate L2/L3 基座:幂等键/receipt/补偿,what-if VACUUM INTO 分叉);五状态工具写路径与 brief/nudge/metrics 读路径全部接线,`gotry_session_search` 审计落盘生产路径,ASYNC_DIR 接 stateRoot;旧 JSON/JSONL 降级为单向导出视图(`state-cli export`,红线 6),首写自动 one-shot 迁移+快照(`pre-ledger-backup/`);run-all §28(39 断言)/§29(CLI e2e 14 断言)。**Z3 求解面收敛(2026-08-29,README Known limitation「Z3 WASM race」清偿)**:`ts/src/z3-shared.ts` 单一 WASM 实例 + 单一 Context + 会话级互斥门(`withZ3`),engine/journey/unified 三模块全部过门、engine.solve 弃 `Promise.all` 改串行——同 Context 并发 unwind(Asyncify 栈损坏→`memory access out of bounds`)与三实例并存的 OOM 形态一并根除;run-all §1「重试一次」止血退役,新增 §30 进程内三形态并发回归闸 ×12。**i18n 英文面工程层(2026-08-29,同批)**:`i18n.ts` 消息目录——zh-CN 默认且与金标准逐字节一致,`GOTRY_LOCALE=en`(或 setLocale('en'))切英文、en 缺键回退 zh;覆盖求解确定性面(候选/航班链 answer_md、放宽建议、排除理由、wish 理由);run-all §32;工具卡(宿主面)与人格对话面待 M4 校准样本随补。**实时票价接入(2026-08-29,同批清算)**:`ts/src/realtime-pricing.ts`——dated 航班链段(spec 带 date+route 词表内城市对)经 FlyAI 官方只读通道按航班号精确匹配覆写 spec 价格,证据链 `[实时API:flyai@ts]` 并进 skeleton_notes;miss/error/打码价/无匹配一律降级回静态包,永不抛错;`realtimeSolvePort`(env 闸 `GOTRY_REALTIME_PRICING`,默认关)接线 replay-real 真模型巡检 solve port——静态包由唯一来源变为显式降级,run-all §31(纯离线注入)。**贡献基建(2026-08-29,开源协作面)**:GitHub Actions CI(node 22/24 矩阵:typecheck + 全栈回归 §1-§34,`GOTRY_SESSION_LIVE=0`);`CONTRIBUTING.md` + issue/PR 模板;lockfile(root/ts 双份)与 dsh-runtime 三 manifest(package.json/pnpm-lock/pnpm-workspace)入 git,resolved 全量从 bnpm 内部镜像改指 registry.npmjs.org(integrity 逐包验证);贡献流程改 PR 制——`main` 收保护不直接推,分支+全绿+PR review+squash 合入。**dsh runtime 升级 alpha.1(2026-08-29,issue #15 跟进,免等上游 npm 发版)**:vendored runtime 从 `0.1.1-rc.2` 升 `0.1.2-alpha.1`——上游 GitHub tag `dsh-v0.1.2-alpha.1` 源码构建(`pnpm build:official` + `pnpm release:pack --family dsh` 产 241 tarball,全量解包入 `ts/dsh-runtime/vendor/`,pnpm workspace 成员 + `linkWorkspacePackages: true` 解析,成员间 `^0.1.2-alpha.1` range 命中本地版本,零 overrides);解包对齐 npm 装机语义(剥离 devDependencies——上游 devDeps 引用未入发布家族的 dsh-experimental-* 私有包;唯 `dsh-subprocess-local` postinstall 保留,恢复 node-pty spawn-helper 可执行位);alpha 的 `--profile` 强制项 gotry 侧早已预落地(`bin/gotry-inner.js` headless 恒带 `--profile headless`,9fad1d7),8-28 源码评审的 API 兼容面(defineTool/systemPrompt.variable/patch)实测确认;CI 不安装 runtime 不受影响,npm 公共分发面(root deps)仍钉 rc.2 等上游 publish;验证 `./gotry help` 版本探活 + tsc + smoke + run-all §1-§32 全绿;溯源与升级流程 `ts/dsh-runtime/vendor/README.md`。**会话传输层定案扩展桥(2026-08-30,issue #21 方案 C,founder「逐连接权限框根本无法使用」实测定案)**:Chrome 144+ 每次 CDP 连接都弹浏览器侧权限框且持久化批准无官方支持(chrome-devtools-mcp #825)——CDP 车道降为显式 opt-in(`GOTRY_SESSION_TRANSPORT=cdp`,诊断/测试,不静默回退),**扩展桥升 PRIMARY**:自研 `extension/` GoTry Session Bridge(MV3 零构建,manifest 固定 key=扩展 ID 跨机器稳定;SW 长轮询取活 ≤20s 维持存活;MAIN-world 被动嗅探 batchSearch——检索请求由站点自己发出,扩展零写行为;cookie-names 只取票据名,值即取即弃)+ `session/extension-bridge.ts` 回环桥(`node:http` 零新依赖,端口池 8791-8795=manifest host_permissions,origin 白名单防网页跨域,queued+inFlight 双表/parked 即时派发)+ `extension-channel.ts` 三 job 封装;登录快路径免标签页秒回;系统弹窗每会话 0 次(对照 CDP 每连接 1 次);`needs-extension`=waiting no-spend 用户门(有界等待,一次性安装指引);守卫模型按车道分形(扩展=零写行为+hints 白名单+同款 JSONL 审计;cdp=请求级 abort 保留);`gotry setup` 扩展落位 `~/.gotry/extension`(幂等,`GOTRY_SETUP_EXTENSION=0` 可跳);run-all §38 全离线 23 断言(manifest/固定 ID 派生/Node↔扩展常量防漂移/origin 403/闭环/no-spend),bootstrap-tests 5/5,RFC §2.2/§3.2/§3.3 同步;真实 sf-01..08 双源跑批门禁从「开调试端口+每连接点框」降为「装一次扩展」。
**M3 真实 cohort 证据面(Issue #22,2026-08-29)**:`ts/scripts/product-metrics.ts` 固化样本窗、纳排、分母、归因和 M3 Exit 阈值,输入只接受 HMAC-SHA256 假名键且未知字段 fail-closed;`ts/data/product-metrics-fixture.json` 只验证公式与守门,synthetic fixture 永不产生 business pass。真实证据只进入被忽略的 `ts/gotry-state/evidence/m3/`;当前没有 50–200 人真实 cohort,故 M3 Exit 保持开放。**nightly real-LLM 证据生产器(2026-08-29 同日第二批,Issue #22 验收⑥)**:`ts/scripts/nightly-evidence.ts` 固定封存 prompt 集(`ts/data/m3-nightly-prompts.json`)× 真 LLM,产出 `gotry_m3_nightly_run_v1` 记录追加进私有证据账本 `ts/gotry-state/evidence/m3/cohort.jsonl`;cost_usd 只来自 dsh-llm 新增 usage 累计器(`createOpenAICompatLlm` 返回 port 附带 usage)× 封存价表 `ts/data/llm-price-table.json`(DeepSeek V4 官方 peak 价,只高不低,未知模型 fail-closed 不猜价);无凭证 = waiting_external_evidence/backoff/no-spend 零写入,预算闸 `GOTRY_NIGHTLY_BUDGET_USD`(默认 $1)超限退 3,prompt_set_sha256/output_sha256/run_key 确定性锚定;run-all §35 纯离线合同验证,真跑花钱不进 CI(heartbeat/founder 手动执行)。

**会话数据面 #21 当前增量(2026-08-29)**:首个非门禁切片已落地 `session-double-source.v1` 字段级 fixture scorer 与双源可比性合同;`waiting_attach`/`waiting_login`/challenge/ReadGuard 均为 no-spend 停止态。真实 sf-01..08 Chrome attach 验证仍须用户手工开启 remote debugging、确认浏览器侧权限并完成 CDP 握手;仅打开设置页不算成功 attach。

**M4 Issue #20 价值证据合同(2026-08-29)**:`ts/scripts/memory-value-report.ts` + `ts/data/memory-value-fixture.json` 固化唯一匿名用户首次/下一次 eligible completed flow 的 paired measurement,returning 必须晚于 first 完成,active planning duration 只扣预声明且互不重叠的 external waits,统一输出 N/p50/p75/逐 pair reduction、experience reflux、偏好溯源/硬过滤红线与 P4 trigger 闸。`synthetic_fixture` 永不充当 Exit 证据;真实 `observed_private` N≥5 repeat cohort 尚缺(D-19);run-all §34 固化合同与负例。

**里程碑口径(Issue #19,2026-08-29)**:M3 工程与分发面已就绪,但真实种子用户 evidence 未收口,M3 Exit 仍开放;M4 由 founder 授权并行推进,Issue #20 scorer 已落地而真实 `observed_private` N≥5 仍缺,这些 M4 切片不构成 M3 Exit 证明;M5/M6 仅在各自 Entry gate 满足后启动。

**异步终态合同(Issue #19,2026-08-29)**:`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0,将非 4/4 映射为 `failed`/ledger `failed`/exit 2;终态复诵返回同一结构化结果与退出码且零重算。


**预订 saga 状态机具名化(2026-08-29,issue #17 采纳)**:「多 Agent 协同用 FSM 显式建模」提议的处置——机理全有归宿(共享态/原子更新=账本;检查点=events+fold;防重复副作用=workflow_steps exactly-once+idem_key;HITL=pending 持久挂起+ApprovalSeam),LangGraph 编排不引入;本次落地**词汇层** `ts/src/booking-saga.ts`(booking_saga_fsm.v1,纯函数):状态字母表与 pending_writes CHECK 逐字一致、四条边全函数边表(12 格含结构化拒绝闭集,吸收态无出边)、审计链校验器(合法路径四条/空 receipt 抓出),run-all §36 物理对账 25 断言锁定「词汇层=账本 saga 基座语义,分叉即红」。ADR-17 三口径:①企业审批=pending 持久挂起+外部事件沿边恢复,复用 ApprovalSeam;②合规检查恒为 deterministic-edge(Z3 命名约束/unsat core),永不做成 LLM Agent 节点;③M5 启封增量(空 receipt 物理 CHECK/booking seam 词汇/L2 L4 接线)仍是 M5 Entry 交付物(M4 exit + 供应链协议开闸),本词汇层不构成里程碑证据。设计文档 `booking-saga-fsm.md`。

**效应解译器落地(2026-08-29,issue #16 采纳,ADR-18)**:外部依赖隔离走「效应描述+解译器」——工具层只产纯数据效应值 `{effect, params}`,渠道访问/退避重试/断路器/编译期 mock 全部收敛到解译层(`ts/capabilities/effect.ts` effect_interpreter.v1 + `resilience.ts`,run-all §37);垂直切片五个渠道工具(flyai/hotel/session/weather/flight_verify)+realtime-pricing 查询口已改走 `interpretEffect`,渠道韧性策略 per-效应显式拍板(默认全关零行为变化,Sentinel 永不重试/SESSION 永不重试不熔断/免费源退避 2 次),浏览器解译=既有 SESSION CDP 通道、不做视觉 CUA(零 Python 红线),不做渠道自动路由(OTA 平铺);余下渠道工具增量迁移记 D-23。设计文档 `effect-interpreter.md`。


**产物面最小切片(Issue #25,2026-08-29)**:`gotry_artifacts_list/read`(第 19/20 工具)——账本 workflow_runs 交付 + dsh 工作目录顶层 md 在 dsh 内可发现、可读(dsh read 卡行号文件视图,工单 id 直读 + offset/limit 翻页);只读能力层 `capabilities/artifacts.ts`(路径白名单 = stateRoot+工作目录、排除 node_modules/.git;扩展名白名单 = 文本类),smoke §13。面板第二切片(同日,founder 指令「看 dsh-market 成熟组件」):自建零依赖 webui 因 UI 品质不达产品级撤回,改走宿主组件 **dsh-better-sidebar**(dshmarket.com #1 UI,18.9 万周装,v0.17.1 双形态兼容)——`gotry setup` 宿主层安装(dsh plugin → ~/.dsh/profiles/web,不进 gotry 依赖),dsh web 右侧工作台(文件树/Markdown/Mermaid/PDF 预览)直接浏览工作区产物;账本感知产物 Tab(better-sidebar registerTab,需 client-half 插件面)列下一阶段。

## 2. 总体架构:五层与现状

```
L1 交互:对话即界面(gates 以消息内选择题呈现;独立 UI 属 Stage 1 后)
L2 编排:对话循环 ts/src/loop.ts —— LlmPort(mock✅/真✅ provider-neutral) + 确定性访谈 + 求解挂载
    └ dsh 插件 gotry-tools:✅ 已在真实 dsh headless 运行时端到端(68ea364 rc.1 起实证;2026-08-29 起 vendored `0.1.2-alpha.1` 源码 tarball,ts/dsh-runtime/vendor/,smoke+全栈回归全绿)——模型经 pi-ai(MiniMax-M2)主动调用 gotry_feasibility_check 并引用引擎数字;组合见 cordis.gotry-patch.yml(bin/gotry-inner.js 运行时生成;ts/ 下旧副本已退役 2026-08-28)
L3 领域:统一行程模型 ts|py unified.* —— Segment/Option/锚点/工作窗口/时区
    └ 可行性引擎:Z3 选择 + 命名约束 + unsat core 归因 + Optimize 最优
L4 数据:静态数据包 data/*.json(真实班期+估算价,证据标注)+ 金标准用例
L5 治理:loopx(objective/gate/evidence/quota,验证后才花费)
```

| 层 | 职责 | 契约 | 不变量(任何演进不得破坏) |
|---|---|---|---|
| L1 | 呈现与采集 | 透明卡片 schema(D1 §6) | why/cost 必达用户;gate 只能是选择题 |
| L2 | 理解与编排 | `ts/src/contracts.ts`(TripState+五工具) | LLM 不做算术判定;写操作必过 WriteGate |
| L3 | 判定与核算 | 统一行程模型(§4)+TrueCost | 算术与求解分层;算术纯函数可独立测试 |
| L4 | 数据与能力 | CLI/JSON 桥(hotelbyte-cli 式) | 证据链标注([实时API]/[共享经验]/[估算]);估算必须显式标记 |
| L5 | 治理 | loopx 状态 | 验证后才花费;阻塞记录而非空转 |

数据流(洱海金标准,一次调用走完全程):

```
素材(照片+一句话)→ 动机访谈(确定性缺失字段驱动)→ JourneySpec 抽取
  → solve_unified(Z3 选班,锚点/工作窗口/预算命名约束)
  → {verdicts, exclusions(带理由), red_flags, 最优预算} → 渲染(卡片+gates)
  → 不可行候选 → wish pool(成行条件:天数/预算/季节)
```

## 3. 代码地图(每个模块是什么)

| 文件 | 角色 | 状态 |
|---|---|---|
| `ts/src/contracts.ts` | 顶层数据与工具契约(TripState/五工具 IO/wire schema) | 草案,待创始人走查 |
| `ts/src/loop.ts` | 对话循环:runTurn/interviewNext/异步深度规划(request/collect+不失望四条) | ✅ 重放验证 |
| `ts/src/mock-llm.ts` | 剧本 LLM(ADR-8):确定性重放真实对话的智能侧 | ✅(S4 后留作回归夹具) |
| `ts/src/unified.ts` | **统一行程模型 TS 版(唯一求解入口)**:Segment/Option/时区/工作窗口+Z3 求解(航班链)+枚举求解(候选形态) | ✅ 4/4+候选对账 |
| `ts/src/model.ts` | 门到门全成本算术(纯函数,单候选形态) | ✅ |
| `ts/src/engine.ts` `journey.ts` | 旧两套求解面(纯 oracle,金标准对照) | **deprecated** |
| `ts/src/index.ts` `bridge.ts` | dsh 插件(纯 TS unified 求解 + hbcli 桥 + 进程护栏,延迟计量) | ✅ smoke |
| `py/gotry_feasibility/unified.py` | Python oracle(v0.0.1-rc.2 后**仅历史对照**,不再被产品运行时引用) | 保留 |
| `py/gotry_demo/` | **已删 2026-08-22**(D-7 尾债:demo 规划书生成器曾调废弃 journey.solve_journey;产物 docs/demo-plan-2026-07-17.md 留 git 历史) | — |
| `ts/scripts/replay.ts` `replay-async.ts` | **验收夹具**:真实对话重放(13 轮→3 轮)与异步形态 | ✅ |
| `ts/scripts/{engine,journey,unified,diff}-tests.ts` | 套件(8/5/4 断言+TS-vs-TS 同 spec 稳定性) | ✅(diff-test 顺序偶发为已知问题,v0.0.1-rc.2 后不再依赖 Python) |
| `ts/src/time-anchor.ts` | **时间锚点层**(ADR-12,纯函数):锚点卡渲染(今天/相对周/月分段/季度/节日)+ 绝对月日解析;persona 与抽取链路的「今天」唯一来源 | ✅ time-eval §1 |
| `ts/src/travel-slots.ts` | **槽位抽取层**(travel_slot_extraction.v1):schema + 抽取 prompt + 过期校验 + language 检测 + 评分器;逐字保留,判定归代码 | ✅ time-eval §2-4 |
| `ts/src/slot-spec.ts` | **槽位→日期解析层**(D-10 切片 A):锚点卡词表 + 绝对表达 + 「+N」后缀 → YYYY-MM-DD;词表外 unresolved 逐字保留(ADR-12 边界:不做开放式解析);spec 日期一致性闸 | ✅ time-eval §5 |
| `ts/src/tool-packet.ts` | **工具观察 envelope**(RFC S1/ADR-13):GotryObservation 平封形状 + ToolFailure + interpretArgs 参数三形态归一唯一入口 | ✅ smoke §9 |
| `ts/src/memory-utility.ts` | **记忆效用 sidecar**(RFC S2/ADR-14):recalled/applied/verified_outcome 事件 + 幂等追加 + 只读投影;归因只认 owner 确认 | ✅ smoke §10 |
| `ts/src/memory-decay.ts` | **时间窗衰减原语**(memory-design P3):30/90/180/365d 分级因子(地板 0.1)+ 种类权重 + 新鲜置信度;动机层零衰减为构造性保证 | ✅ run-all §23 |
| `ts/src/companions.ts` | **同行人档案**(memory-design P2):upsert 合并 + 负面清单守卫(证件/电话零入库);约束只进排序 | ✅ run-all §21 |
| `ts/src/travel-timeline.ts` | **旅行时间线**(memory-design P1):trips.jsonl append-only + 幂等/重叠冲突即停 + verified↔timeline 交叉一致 | ✅ run-all §20 |
| `ts/src/wish-pool.ts` | **愿望池匹配纯函数**:条件评分 + 0..1 挑选(muted 排除/确定性 tie-break);wish_pool_list 与 nudge 共用 | ✅ run-all §21 |
| `ts/capabilities/flyai.ts` | **FlyAI 官方通道**:飞猪 8 只读工具的管道层(search-flight/train 先接),证据链 `[实时API:flyai@ts]` | ✅ run-all §24-F |
| `ts/capabilities/session-search.ts` + `session/` + `extension/` | **会话检索面**(RFC P1-P3.5):传输=扩展桥 PRIMARY(`extension/` MV3 + `extension-bridge.ts` 回环桥,零新依赖)/cdp 显式后备(ReadGuard 写请求物理拦截+审计,fail-closed)/persistent 测试;携程机票适配器(batchSearch 嗅探)/action-cache 自愈层(变量化key+指纹被动失效+miss回写);节律闸;`[会话:*]` 证据链 | ✅ run-all §25/§38 |
| `ts/capabilities/artifacts.ts` | **产物面**(issue #25 最小切片):产物发现(账本 workflow_runs 权威 + 无账本回退 async 目录视图 + dsh 工作目录顶层 md)+ 行号窗口读取(dsh read 卡);只读,路径/扩展名白名单 | ✅ smoke §13 |
| `ts/capabilities/effect.ts` `ts/capabilities/resilience.ts` | **效应解译器 + 韧性原语**(effect_interpreter.v1,issue #16 采纳/ADR-18):效应值注册表(渠道 handler+策略表)+生产/mock 解译器(渠道 observation 原样透传+trace 横切证据)+ 指数退避(withRetry)/断路器三态(CircuitBreaker);已接 flyai/hotel/session/weather/flight_verify 五工具与 realtime-pricing 默认查询口,余下渠道走 D-23 增量迁移 | ✅ run-all §37 |
| `ts/src/state-ledger.ts` | **事务化状态账本**(ADR-15):SQLite 单文件唯一权威(events append-only+语义幂等键/投影表 fold 可重建/workflow_steps durable 工单/pending_writes saga)；`gotry_async_terminal.v1` 固化 4/4/非 4/4 终态、退出码与零重算复诵;守门纯函数复用为写路径与 fold 处理器;读路径带旧文件回退;首写自动 one-shot 迁移+快照 | ✅ run-all §28 |
| `ts/src/booking-saga.ts` `ts/scripts/booking-saga-tests.ts` | **预订 saga 状态机词汇层**(booking_saga_fsm.v1,issue #17 采纳/ADR-17):状态字母表+四条边全函数边表+结构化拒绝闭集+审计链校验;§36 与账本 saga 基座逐格物理对账 | ✅ run-all §36(纯函数,零写路径接线) |
| `ts/scripts/state-cli.ts` | **账本操作面**(ADR-15):migrate/export(视图单向)/log/stats/rebuild/rewind/forget(物理硬删带审计)/tick(回收 pending 工单)/whatif(VACUUM INTO 分叉)/pw-*(WriteGate saga CLI 面) | ✅ run-all §29 |
| `ts/scripts/product-metrics.ts` `ts/data/product-metrics-fixture.json` + `ts/scripts/nightly-evidence.ts` `ts/data/m3-nightly-prompts.json` `ts/data/llm-price-table.json` | **M3 cohort 证据评分面 + nightly 证据生产器(Issue #22)**:阈值冻结 manifest + 脱敏 cohort/nightly schema + 定稿率/NPS/POI 幻觉率 scorer；fixture 与真实证据分流，未知字段 fail-closed；nightly 生产器封存 prompt 集与价表(peak 保守上界,未知模型 fail-closed)、无凭证 waiting/backoff/no-spend、超预算退 3,记录写入前必过消费方 parseNightlyRun | ✅ run-all §33/§35；真实 cohort 待收集,nightly 真跑记录待凭证环境执行 |
| `ts/scripts/time-eval-tests.ts` `data/time-slot-eval.json` | 时间感评测(25 题):确定性部分进 CI,`--real` 真模型巡检(只读报告) | ✅ 真模型 25/25 |
| `data/golden_erhai.json` `flights_2026.json` `hotels_2026.json` `golden_trip_2026.json` `行程细化计划.docx` | 金标准用例/班期/住宿/完整任务/Kimi 对话原件 | — |

## 4. 统一行程模型(领域核心,唯一求解入口)

```
JourneySpec = { segments, budget?, workWindow?, 默认起床线, … }
Segment     = { id, role: choice|fixed, anchors{arrive_by/depart_after/…}, options[] }
Option      = { id, move(services×transfers×缓冲×红眼×tz), stay?(晚数/价格/work_window), score, min_days }
```

- 两种形态同一模型:候选选择(洱海=1 段 3 目的地 Option)与段链(demo=5 段);旧 engine/journey 是其在单段/固定链上的退化,已 deprecated。
- **求解分层**:算术纯函数(`evaluate_*`:起床/到达/精力/有效时长/金钱)与 Z3 选择(命名约束,unsat core 归因,Optimize 最优)严格分离。
- **时区语义(D-5 已清偿)**:真实飞行=(到−发)−时差;门到门=前置+真实飞行+接驳(EK329 全链 11h20m,飞行 7h35m 与官网逐分一致)。
- **工作窗口(M-1 已落地)**:家时区→出发地当地换算;工作日窗口内起飞的 Option 求解前确定性排除,理由入记录——gate q3 被一条规则确定性回答(周五晚班全排除,只剩周六早,与真实选择一致)。
- **红眼睡眠模型**:精力=30+8×(飞行−1h),clamp[30,75];EK329 落地 75%(待对账 Q10 校准)。

## 5. 对话循环(L2)

`runTurn(state, msg, llm, solve)`:抽取事实(日历一次断言,冲突显式指出)→ 增量访谈(缺失字段驱动,workWindow/bookedResources 为求解前置,budgetTier 降为 gate 不阻塞)→ 约束齐备则 extractSpec→solve→渲染(方案+排除理由+红旗+gates 选择题)。复杂行程切**异步深度规划**(「一小时后回来看看」;回访交付自带不失望四条自检)。详细设计见 `stage1-top-down-design.md`。

**重放验收**(`ts/scripts/replay.ts`):Kimi 的 13 轮失败 = GoTry 3 轮;日历零反复;工作窗口与已订酒店首轮即被问出;终轮即已验证方案。

## 6. 数据与运行时

> **数据源唯一权威面 = `data-sources.md`**(2026-08-22 立):领域矩阵 × 四层架构(静态包/免费实时/hbcli 桥/OSM 生态) × Google Place 链路(hbcli→search OpenAPI→geography) × 证据链契约 × TREK 参考采纳。本节只留运行时概要。

- 运行时:三条已实证路径——①TS 进程内(自研循环,~6ms/解);②真实 dsh headless+cordis 组合(pi-ai→MiniMax,`cordis.gotry-patch.yml`,68ea364);**(v0.0.1-rc.2 起第三条** Python CLI 桥下线,纯 TS)。环境三件套 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`(兼容旧 DEEPSEEK_*)。
- 复用落地:dsh(import,rc 已对齐)/loopx(import,0.5.1 运行中)/Z3(import,双绑定)/hotelbyte-cli(import+extend,place 链路见 data-sources.md §4)/travel_agent·ai-agent-book·TREK(reference,零代码——TREK 数据面模式采纳表见 data-sources.md §5)。

## 7. 测试与验证策略

**评测三层(ADR-11)**:
- **回归层(防退化)**:TS-vs-TS 双路径稳定性(同 spec 不同 module instance)+ 金标准断言(洱海 8+5、普吉链 4、统一模型 20/20)+ **重放夹具**(mock 重放即行为级回归,Kimi 对话是失败基线)。**v0.0.1-rc.2 起:** 不再依赖 Python oracle 差分;run-all-tests 9 套一次性绿,无需 Python 运行时。全栈入口:`scripts/run-all-tests.sh`。
- **质量层(防漂移)**:评测集+指标面板——POI 幻觉率、定稿率、不失望四条、NPS;M3 上线(见 `tech-strategy.md` §4),此前以 replay 终态断言兜底。
- **巡检层(防「mock 绿而真智能烂」)**:真 LLM 重放(`replay-real.ts`)的 nightly 形态已落地——`nightly-evidence.ts`(封存 prompt 集+封存价表,预算闸 `GOTRY_NIGHTLY_BUDGET_USD`,无凭证 waiting/backoff/no-spend 零写入,run-all §35;真跑花钱不进 CI,heartbeat/founder 手动执行);ADR-10 正是 mock 绿而真 LLM 烂出来的,教训制度化。

## 8. ADR

**生命周期**:提案 → 采纳 →(已清偿 | 被取代 | 退役);「永不复审」是显式终态类(ADR-7/9/10 依据的是不变量级判断)。**三个诞生渠道**:① 失败诞生——真实运行暴露 mock/推演看不见的问题,当天立 ADR(ADR-10 模式);② 对账诞生——`demo-reconciliation.md` §三:模型缺项→记 ADR 并评估是否进引擎;③ 里程碑复审诞生——M-exit 全表过一遍淘汰/复审条件(§11),触发的当即立项。**锚点**:每条 ADR 必须有代码/测试执行锚点,或显式标注「流程级」——没有锚点的 ADR 会在演进中悄悄失效而无人察觉。

| # | 决策 | 备选与取舍 | 淘汰/复审条件 | 锚点 |
|---|---|---|---|---|
| 1 | Z3 作判定层 | 规则引擎/OR-Tools/纯 LLM(4.4%) | 求解 >500ms 或变量 >10³ 评估 OR-Tools;unsat core 不可让渡 | `unified.ts`/`unified.py` 求解层;双侧套件 |
| 2 | 双实现 TS 生产+Python oracle | 单实现(无对账) | **2026-08-22 v0.0.1-rc.2:** Python oracle 路径下线(diff-test 改为 TS-vs-TS,run-all-tests 不再依赖 Python 运行时);py/ 保留为历史对照(不删),**不再被产品运行时引用**——npm 一键分发前提 |
| 3 | 桥接收敛:进程内优先 | 全 TS/全 Python | **2026-08-22 v0.0.1-rc.2:** Python 桥下线,仅剩 hbcli 桥(vs hbcli & hbcli fallback);每桥 ≤2 不变 | `ts/capabilities/hbcli.ts`;`bridge.latency.jsonl` |
| 4 | loopx 为控制平面 | 自研状态机 | 概念冲突且无法适配时 | 流程级(`.loopx/` 治理状态) |
| 5 | 统一行程模型 | 维持双引擎 | 已清偿(engine/journey 退役日=迁移完成日,D-7 跟踪) | `unified.ts`/`unified.py` |
| 6 | 静态数据包(demo 期) | 直接接 API | M2 退役为夹具 | `data/*.json`;金标准用例 |
| 7 | 算术/求解分层 | 混合 | 永不复审 | `model.ts`/`model.py` 纯函数层(分层测试结构) |
| 8 | mock-LLM 先行 | 等 API key(伪阻塞) | S4 完成后 mock 留作回归夹具(已兑现) | `ts/src/mock-llm.ts`;`ts/scripts/replay.ts` |
| 9 | 访谈确定性(缺失字段驱动) | LLM 即兴(Kimi 病根) | 永不复审 | `loop.ts interviewNext`;replay 夹具(首轮问出工作窗口) |
| 10 | 翻译≠造数:LLM 只产骨架与锚点,班次数据永远来自能力层(数据包→实时API);spec 校验闸兜底 | 让 LLM 直接产出完整 spec(实测:MiniMax-M2 编不出时刻,要么编造要么卡死) | 永不复审 | `loop.ts validateSpec`;`dsh-llm.ts SKELETON_SYSTEM`;`replay-real.ts` |
| 11 | 评测分层进架构:回归层(单元/差分/重放)防退化、质量层(评测集+指标面板)防漂移、巡检层(nightly 真 LLM 重放带预算闸)防「mock 绿而真智能烂」;M-exit 必过对应层级 | 只靠重放夹具(质量漂移无感)/事后补评测工具(指标不进架构等于不存在) | M3 exit 指标面板上线后复审一次 | `run-all-tests.sh`;replay 三件套;`tech-strategy.md` §4 |
| 12 | 时间感分层:锚点卡(time-anchor 纯函数,算术进代码)+ 槽位逐字保留(LLM 不换算不翻译)+ 过期/language 判定归代码层;时间评测集进仓(data/time-slot-eval.json,只增不改语义),质量层首块落地 | 全 LLM 感知(锚点缺失实测:legacy 路径无今天注入,过期无从判)/代码全量解析中文相对日期(表达开放,维护黑洞) | **2026-08-27 复审(D-10 切片 A 触发):设计成立**;补充边界——解析层只认锚点卡词表+绝对表达+「+N」后缀,词表外 unresolved 逐字保留,不开式解析(锚点:`slot-spec.ts`;time-eval §5) | `time-anchor.ts`;`travel-slots.ts`;`slot-spec.ts`;`time-eval-tests.ts` |
| 13 | 工具观察 envelope(RFC S1,effect-interpreter 映射):12 工具成功路径平铺 `ok:true` + 载荷,失败 `{ok:false,summary,evidence}`(guard 兜底同形,`ToolFailure` 编译期对齐);参数三形态归一唯一入口 `interpretArgs`(原 unwrapQuery 移居 `tool-packet.ts`) | 逐工具自由返回(形状漂移,每个新工具重新猜)/嵌套 envelope `{ok,value}`(渲染/调用方全要拆包,侵入大) | 出现第二个真实调用方(非 dsh 非 smoke)需要不同观察形状时复审 | `tool-packet.ts`;`incident-log.ts guardToolExecute`;smoke §9 |
| 14 | 记忆效用 sidecar(RFC S2/S3,post-outcome-memory 映射):recalled/applied/verified_outcome 三类事件 append-only(`gotry-state/memory-utility.jsonl`),归因只认 owner 确认(attribution 只能在 confirm-outcome 由用户明说落盘,模型不许自评「有用」);wish 稳定 `wish_id` + muted(休眠不删除);召回 0..1/轮(`gotry_wish_pool_list` 条件评分,muted 永不召回,无命中不硬推)——M4 北极星「下一次出发率」的度量底座 | 召回即记「有用」(自称用了≠让结果变好)/wish 删除制(憧憬不被拒绝) | 多用户 AaaS 账本化(RFC §6.5)或出现第二个效用消费方时复审 | `memory-utility.ts`;`index.ts gotry_wish_pool_list`;smoke §10 |
| 15 | 事务化状态基座(RFC `transactional-state-rfc`,业界 durable-execution 五件套收敛):单文件 SQLite 账本(better-sqlite3,WAL)= 唯一权威——events append-only(语义幂等键 UNIQUE 物理化,wish_id 语义派生)+ 投影表 fold 可重建(纯函数守门原样复用,语义层零改造)+ 红线进事务(evidence/conditions 拒绝即回滚)+ durable 工单(workflow_steps intent-before-execute,崩溃恢复 exactly-once)+ pending_writes saga(WriteGate L2/L3 基座:幂等键/receipt/补偿)+ what-if 分叉(VACUUM INTO);旧 JSON/JSONL 降级单向导出视图(红线 6);one-shot 迁移(首写自动+快照 `pre-ledger-backup/`) | Postgres/DBOS/Temporal/Restate 平台(单用户本地产品不需要服务端;SQLite durable 学派「一文件即控制面」)/纯文件加固 tmp+rename(修不了跨文件分叉与并发)/node:sqlite(零依赖但较新,D1 落选备选) | 多用户 AaaS 化(RFC §6.5 claim/CAS 实装)或需要多写者/多端复制(cr-sqlite/Litestream,触发式=D-15)时复审 | `state-ledger.ts`;run-all §28/§29 |
| 16 | 双形态架构冻结(本地+Web,通用 agent 产品形态):**一套账本语义,两种宿主绑定**——本地=better-sqlite3 直读文件,Web=同一 schema 跑在每用户 SQLite 文件(或 Postgres,schema 同构);**tenant_id 从第一天就是一等字段**(events/投影/工单/pending_writes 全部带租户列,单用户期恒为 `'local'`,主键空间化防跨用户撞);**同步=账本事件的复制而非状态的翻译**(events 行带 tenant_id+幂等键,双端合并天然幂等);写必经账本、读必带租户上下文进不变量表 | 本地与 Web 各长一套逻辑(多用户期合并不动,推倒重来)/云端为权威本地为缓存(违反红线 6 本地优先)/同步投影而非事件(投影是派生态,合并会分叉) | 永不复审(双形态是产品形态基座);同步协议实装(Litestream/cr-sqlite/自建 API)与 claim/CAS 实装仍按触发器后置 | `state-ledger.ts` schema v2;run-all §28 双形态断言 |
| 17 | 预订 saga 状态机具名化(issue #17 采纳,2026-08-29):预订/支付/退改的 saga **不引入编排框架(LangGraph 等)**,FSM 落为账本 pending_writes 的具名字母表+四条边全函数边表(`booking_saga_fsm.v1`,纯函数零接线);三种边型入词汇——deterministic-edge(合规/政策判定恒为代码层 Z3 命名约束/unsat core,永不做成 LLM Agent 节点)/gate-edge(用户选择题)/external-event-edge(HITL 审批=pending 持久挂起+外部账本事件恢复,复用 ApprovalSeam);M5 Entry 后任何 booking seam 只许走该边表 | LangGraph/Temporal 式 FSM 框架(第二运行时,违反 harness 基线与复用矩阵)/状态散落 SQL 字符串(边语义漂移无词表)/多 Agent 提示词协同(隐式依赖,ADR-9/10 教训) | M5 拍板 WriteGate 时复审(启封增量的 schema CHECK/seam 词汇/L4 自动类);若出现需要并行多写者的预订流,复审 keyed 单写者形态 | `ts/src/booking-saga.ts`;`docs/booking-saga-fsm.md`;run-all §36 |
| 18 | 效应解译器 effect_interpreter.v1(issue #16 采纳,2026-08-29):「效应描述+解译器」下沉到 L4 渠道边界——工具/编排层只产纯数据效应值 `{effect, params}`,`ts/capabilities/effect.ts` 注册表换算成渠道 handler 调用;**韧性横切(指数退避重试/断路器)只能来自 per-效应策略表,没有策略行就没有效应(默认全关=零行为)**;生产/mock 双解译器同接口(`selectInterpreter` 环境注入,mock=夹具回放零网络),渠道 observation 原样透传 + trace 横切证据;浏览器解译=SESSION_* 效应(CDP attach+ReadGuard+授权闸),视觉 CUA 不做(零 Python 红线);解译器**不做**渠道自动路由/比价聚合(OTA 平铺是 founder 判定) | 逐工具自由调用能力层(横切逻辑复制,无退避/熔断/mock 面)/Python browser-use(违反零 Python 依赖)/解译器内置多渠道路由排序(违反 OTA 平铺)/全量重写 20 工具(风险大,走增量迁移 D-23) | 出现需要跨渠道比价聚合的产品裁决时复审「平铺」边界;写效应(预订/支付)入注册表时必须走 booking_saga_fsm.v1 边表(M5 Entry) | `ts/capabilities/effect.ts` `resilience.ts`;`docs/effect-interpreter.md`;run-all §37 |

## 9. 演进(时间线唯一来源= `roadmap.md` 的 M0-M6;此处只保留原则与现状)

原则:**不跳阶段,不提前优化下阶段的事**;每阶段 Entry/Exit/gate 见 roadmap。旧 Stage 0-4 与总纲 Phase、产品 M1-M3 已归并映射到 M0-M6(映射表在 roadmap)。

- **M0 ✅ / M1 ✅(bb880f3)/ M2 ✅(b0cfd97)**:M2 交付 = §7-1 三层组合(骨架+校验+锚点)+ hbcli 桥 + dsh 端到端(DeepSeek 原生,人格+五工具)+ 一键入口 `./gotry`;G1/S1/§7-1 三 gate 由创始人指令结算。
- **当前主线 = M3 evidence 未收口；并行线 = founder 授权的 M4 记忆域**:M3 工程与分发面已就绪，真实种子用户的定稿率/NPS/POI 幻觉率证据仍是 Exit 缺口。M4 自 2026-08-26 起获 founder 授权并行推进；T1 及后续记忆切片、Issue #20 scorer 的落地都不构成 M3 Exit 证明，真实 `observed_private` N≥5 repeat cohort 仍缺。M5 交易与 M6 B2B 仅在各自 Entry gate 满足后启动，不得由并行实现倒推开闸。
- **M3 真实证据并行线(Issue #22)**:v1 manifest、脱敏 cohort/nightly schema、确定性 scorer 与 fixture 守门已进入工程面；业务达标只接受阈值冻结的 `real_seed_cohort`，fixture 恒 fail。真实 cohort 仍为空，等待 50–200 个脱敏样本，不宣称 M3 Exit。
- **时间感优化(2026-08-27,外部时间评测驱动)**:时间锚点层(算术进代码,LLM 查卡不自算)+ 槽位抽取 v1(逐字保留)+ 25 题评测集与评分脚本落地,ADR-11 质量层首块兑现(原定 M3,迟到的落地);真模型(deepseek-chat)25/25。slot→spec 求解桥接未做(D-10)。
- **tsc 存量清零 + loopx RFC 专项(2026-08-27)**:`npx tsc --noEmit` 14 错清零(D-11 清偿,1bf9671);同日完成 loopx 13 篇架构 RFC 通读与映射,产出 `loopx-inspired-upgrades-rfc.md`——**founder 当日指令 accepted(「按建议执行」)**,四切片 S1-S4 按序落地;同指令确立**多用户 Agent as a Service** 为未来方向(shared-goal-authority 类 claim/CAS 机制转入远期采纳面,RFC §6.5)。**S1 已落地**:`tool-packet.ts` 观察 envelope(平铺 ok:true/ok:false summary,guard 兜底同形编译期对齐)+ unwrapQuery 升格 interpretArgs;S2 记忆效用 sidecar → S3 wish 触达纪律 → S4 WriteGate 词汇依次推进(D-12)。
- **事务化状态基座落地(2026-08-28,ADR-15)**:业界调研(loopx/DBOS/Temporal/Restate/LangGraph/Letta/Claude Code transcript 学派/SQLite durable 学派/TigerFS/SagaLLM/Cockroach 七失效模式)收敛五件套(append-only 账本/投影/约束即红线/步骤日志/saga 补偿)→ `transactional-state-rfc.md` 立例、founder 当日 accepted(「按你的建议来」,D1-D5 全按建议结算)。TS-0..TS-4 一次落地:`state-ledger.ts` 账本 + 五状态工具写路径接线 + brief/nudge/metrics 读路径回退兼容 + `state-cli` 操作面 + durable 工单崩溃恢复 exactly-once(§28 子进程 exit 9 实证)+ `gotry_async_terminal.v1` 4/4/非 4/4 结构化终态、差异退出码与零重算复诵 + pending_writes saga;run-all §28/§29。TS-5 触发式后置=D-15。**同日 ADR-16 双形态冻结**:本地+Web 一套账本语义,tenant_id 一等字段(schema v2),同步=事件复制非状态翻译;§28 双形态断言(同库双租户互不串)。
- **会话数据面 #21 首切片(2026-08-29)**:`session/benchmark.ts` 固化 required comparable fields 的 fixture scorer(缺字段计错、默认 90% 闸)与双源合同(按 journey/segments/时刻/班次对齐,价格只记差值不判等)；`needs-attach`/`needs-login` 为 waiting-user no-spend,challenge 与 ReadGuard 非零 fail-closed。纯 fixture 已进 run-all §25；真实 sf-01..08 仍等待 Chrome attach 权限确认与握手。
- **会话传输层定案扩展桥(2026-08-30,#21 方案 C 升 PRIMARY)**:founder 实测「Chrome attach 逐连接权限框根本无法使用」(chrome-devtools-mcp #825:每次连接必弹、无持久化批准)→ CDP 降显式 opt-in、扩展桥主载——`extension/`(MV3 零构建,固定 key=扩展 ID,SW 长轮询,MAIN-world 被动嗅探,cookie-names 只取名)+ `extension-bridge.ts`(`node:http` 回环桥,origin 白名单,零新依赖)+ 车道路由(扩展默认/cdp 显式/persistent 测试);登录快路径免标签页;守卫按车道分形(扩展=零写行为+hints 白名单,cdp=请求级 abort);`needs-extension` → `waiting_extension`(waiting-* 同族 no-spend);run-all §38(23 断言)+ bootstrap-tests 5/5;真实 sf-01..08 门禁降为「装一次扩展」。
- **M4 Issue #20 价值证据切片(2026-08-29)**:paired-cohort 合同、active-planning 扣 wait 口径、experience-reflux 与偏好/P4 红线被一个只读 scorer + 合成 fixture 固化并接入 run-all §34。合成数据明确不可关闭 M4;下一阶段只等真实 `observed_private` N≥5 repeat cohort,无样本时 waiting/backoff/no-spend。
- **已知限制清算第一刀(2026-08-29,founder 指令「解决这些 known limitations」)**:Z3 WASM race 根治——历史债「三模块各自 init 的 WASM 实例并存 + Promise.all 同 Context 并发」双重根因经 `z3-shared.ts`(单一实例/单一 Context/会话级互斥 withZ3)关闭,当年 rc.4 单例回滚的 Context mismatch 来自混用残留 Context,本次三入口同门无混用面;run-all §1 重试止血退役 + §30 并发回归闸;薄壳遗留(`shell/` 目录)物理删除,dsh web 确认为唯一产品面。**实时票价同批接入**:`realtime-pricing.ts` overlay + `realtimeSolvePort` env 闸 + run-all §31(见 §1 尾注)。**i18n 同批**:`i18n.ts` catalog(zh 金标准逐字节/GOTRY_LOCALE=en 切换/en 缺键回退),run-all §32;工具卡与人格面挂 M4 校准。

- **dsh runtime 跟进上游 alpha.1(2026-08-29,issue #15)**:上游 `dsh-v0.1.2-alpha.1` 只挂 GitHub 不发 npm(rc.2 后 1079 commits),「等 publish」改「源码跟进」——vendored runtime 换装 alpha.1 全量 241 包 tarball 解包(`vendor/` + pnpm workspace),免等上游发版;npm 公共面仍 rc.2,上游 publish 后可整体回到 npm 依赖形态。详见 §1 尾注与 `vendor/README.md`。

- **OTA 平铺 + 账号授权闸(2026-08-29 第二批,founder 口径「OTA 这些都是工具,不要区分主路径/降级路径;用用户账号必须跟用户确认」)**:①酒店接入官方只读通道——flyai `search-hotel` 实测(大理:结构化 name/star/打码价 ¥7xx/detailUrl;解析契约 `FlyaiHotelOption`,打码价保 priceRaw 原值、数字价恒 0,防「¥7xx 截成 7 伪装真价」),`gotry_flyai_search` kind=flight|train|hotel 三形态,参数闸 per-kind;②OTA 工具面平铺——工具描述与 persona (19) 去「主链路/交叉验证/三级路由」层级话术(数据层 L4 证据链逐源标注照旧,拍平的是路由优先级不是标注纪律);③账号授权闸(v2,当日二迭代):`session-consent.ts` 挂 `tools/pre-execute`,**每会话每站点首次调用**弹审批卡→会话内记住,**拒绝=本会话吊销**(不再弹卡不再执行;首版逐次弹卡被 founder 实测否决——「每次都要弹,经常无法点击」),sessionAccess `ask|allow|off` 三态,无审批通道/headless fail-closed;授权状态存 Weak<agent> 绝不跨会话延续;④**登录态 seam 落地**:`scripts/session-login.ts`(cdp attach→开登录入口→人登录→只读轮询票据名)替代「跑脚本」空指引;⑤测试纪律:session-tests live 节默认 SKIP,`GOTRY_SESSION_LIVE=1` 显式开启——**例行回归永不自动开用户浏览器窗口**。run-all §24(session-tests §H/§I)+ smoke §12-13;全栈回归全绿。

- **预订 saga 状态机具名化(2026-08-29 第二批,issue #17 采纳)**:针对「多 Agent 协同用 FSM 显式建模副作用传递」提议,逐机理勾稽(共享态/检查点/防重复副作用/HITL 在账本与 durable 工单已物理存在)后,落地词汇层 `booking-saga.ts` + 设计文档 `booking-saga-fsm.md` + ADR-17;LangGraph 编排不引入,合规恒为 deterministic-edge,HITL 审批 = pending 挂起 + 外部事件恢复;run-all §36 物理对账 25 断言。

- **产物面(2026-08-29,issue #25,两步)**:①dsh 内查看——`gotry_artifacts_list/read` 把账本工单交付与工作目录 md 变为可发现、可读对象(read 卡);②成熟面板——dsh-market 调研(dshmarket.com,2495 插件)选型 **dsh-better-sidebar**(★3083/18.9 万周装,#1 UI 组件;自建零依赖 webui 因品质不达产品级当日撤回),`gotry setup` 宿主层安装(GOTRY_SETUP_SIDEBAR=0 可跳,幂等/失败降级路①),dsh web 侧栏工作台浏览+渲染工作区产物;产物 Tab(registerTab client-half)为下一阶段。

- **效应解译器(2026-08-29,issue #16 采纳,ADR-18)**:「效应描述+解译器」落地 L4 渠道边界——`ts/capabilities/effect.ts`(effect_interpreter.v1:效应值注册表+生产/mock 双解译器+渠道 observation 原样透传)与 `resilience.ts`(指数退避 withRetry+断路器三态)。关键保守边界:①韧性策略 per-效应显式拍板,没有策略行就没有效应(默认全关=对既有行为零改变);②FlyAI Sentinel 上游「说不」永不重试但计熔断(3 连错开 60s 保配额),SESSION 通道永不重试不熔断(风控红线),免费源 2 次退避;③浏览器解译=SESSION_* 效应(既有 CDP 通道),零 Python 红线不做视觉 CUA;④不做渠道自动路由/比价(OTA 平铺 founder 判定,agent 层比价)。垂直切片接 5 工具+realtime-pricing 默认查询口,余下渠道增量迁移(D-23)。设计文档 `effect-interpreter.md`;run-all §37;smoke/flyai/hbcli/weather/session/realtime-pricing 套件同轮全绿。

## 10. 债务清单(引擎细节工作只能来自这里)

| # | 债务 | 状态/赎回时机 |
|---|---|---|
| D-1 双引擎算术复制 | **已清偿**(统一模型落地,洱海对账等价) |
| D-2 TS unsatCore 竖线 | **已清偿**(coreOf 剥竖线+回归断言) |
| D-3 LLM 未进环 | **已清偿**(S4 由 MiniMax-M2 完成,`bb880f3`;mock 留作回归夹具,ADR-8 兑现) |
| D-5 时区语义 | **已清偿**(EK329 官网逐分一致) |
| D-4 gate/卡片无承载界面 | **词表内赎回 2026-08-22**:feasibility + 酒店/天气/Anything/AgentReach 五工具 presentResult 结果卡(可行性:候选判定+预算行;酒店:N 家(实时/静态);天气:ok/降级;Anything:N hits;AgentReach:✅/🔧/📦/❌ verdict)+ 12 工具 kind 图标分类(search/fetch/execute/edit,零 other);**地图位已解 2026-08-22**:宿主插件 dsh-map-tools v0.4.4(7 个 map_* 原生工具:驾/公/步/骑路线+地理编码+POI,零 key 走 OSRM,高德可后配)——装于 vendored runtime,npm 分发经根包依赖 + inner 运行时 require 解析;patch 条目占位、缺依赖整块剔除不挡启动;root ./gotry 统一改走 inner(修复旧 profile patch 暗中承重) |
| D-4a'(agent-reach 100% follow) | **已完成 2026-08-23;2026-08-22 wrapper 化**: Agent-Reach v1.5.0 装于 .venv(与 z3-solver 同址);gotry 侧为薄壳 —— agent-reach-bridge.py 反射桥(get_channel+getattr 直调上游注册表)+ agent-reach.ts 管道层,零渠道知识,上游加渠道零改动;gotry_agent_reach(action=reach 反射 / status 真 doctor);needs-setup 透传上游 check() 原话 |
| D-4\'(Anything 数据接入) | **已完成 2026-08-23**: gotry capabilities/anything.ts 11 套实测 5/5 + hbcli `search anything` 子命令 + hotel-be `/api/search/anything` `@path` 注解;三仓 commit 闭环(244a0ae/c38ff65d1/43236a0) |
| D-6 红眼睡眠模型未校准 | **已校准 2026-08-28**:红眼航段落地后接驳(机场→住处/办公室)乘车补眠回血(1h≈+5%,上限 80)——对账真值:引擎原算 75%(机上睡眠),你真实体感 80%(75+1.5h 路上补眠);落地补眠此前未算,现加 `groundRecoveryMin` 参数;EK329 精力 75→79(45min 接驳×5%/h≈+4),unified 断言同步 |
| D-7 deprecated 层仍承重 | **大部赎回**:dsh 插件进程内路径切轨 solveChoiceSegment(枚举,~0ms)、cli.py 桥切轨 solve_choice_segment、diff-test 切轨统一模型对统一模型;engine/journey 退纯 oracle(保留为金标准对照)。**尾债清偿 2026-08-22**:删 build_plan.py + gotry_async/demo.py + run-golden-case.sh(已断:调 rc.3 删除的 cli.py);py 树仅剩 gotry_feasibility oracle 对照 + 其 unittest |
| D-8 对话循环不进 CI | **已清偿**(replay 带终态断言 + 异步工单跨进程闭环 + smoke 进 `run-all-tests.sh` §5-7) |
| [D-NEW] dsh 进程保活缺失 | **部分赎回(gotry 侧)**: plugins/apply 内 installProcessGuards 挂 uncaughtException + unhandledRejection;incident-log.ts 同步 fsync append-only,handler 不调 process.exit——被崩溃穿透时仍能留下证据(JSONL incidents.jsonl),不阻塞 dsh 控制流。incident-tests 2/2 绿(handler 装上后未捕获异常仍记录,后续控制流不卡)。**gotry 侧收尾 2026-08-22**: 12 工具 execute 统一经 guardToolExecute 异常隔离——抛错/拒绝降级结构化错误返回 LLM + tool_execute_error 落盘,不再穿透 cordis 到 dsh 主循环(incident 套 3/3);残余仅 vendored dsh 自身容错,记 M3 |
| D-9 节日锚点表硬编码 | **2026-08-28 扩表清偿**:SPRING_FESTIVAL 覆盖 2026-2031(2029-02-13/2030-02-03/2031-01-23),time-eval §1b 回归闸(2030 锚点断言 2031 春节)。**跨 2031 前必须再扩表**,否则春节锚点静默缺失 |
| D-10 slot→spec 求解桥接未做 | **已清偿 2026-08-27(三切片)**:A `slot-spec.ts` 解析层(锚点卡词表/绝对/+N → 绝对日期,词表外 unresolved;time-eval §5);B 工具面接线(`gotry_hotel_search` 日期槽位收逐字表达,unresolved 降级无日期搜索+date_notes,smoke §8);C spec 链路一致性闸(runTurn 求解前比对,分歧不求解、追问确认,replay 尾段)。**ADR-12 复审结论:设计成立**,解析范围必须有界(只解析锚点卡词表,不做开放式中文相对日期解析——被拒备选即维护黑洞)。**闸范围边界(2026-08-28 真模型巡检修正)**:槽位 v1 只有 trip 级主日期,闸仅校验恰好一个带日期段的 spec;多段行程逐段日期无槽位真值,不判(金标准六段行程曾被全段误判分歧拦死求解,巡检抓出后收窄,多段旁路回归进 replay 尾段) |
| D-11 `npx tsc --noEmit` 存量 14 错 | **已清偿**(1bf9671,语义零变更:tsc 0 错;smoke/memory §18 全过;17 套 ALL GREEN) |
| D-12 loopx RFC 映射升级四接缝 | **已全部落地(RFC accepted 2026-08-27)**:S1 tool-packet envelope(ADR-13);S2+S3 记忆效用 sidecar + wish 触达 0..1(ADR-14);S4 WriteGate L0-L4 渐进授权词汇进 roadmap M5 交付物(2026-08-28);多用户 AaaS 方向见 RFC §6.5 远期采纳面 |
| D-13 会话适配器维护面(RFC user-session-data-rfc) | **部分清偿 2026-08-30**:action-cache + 金标准输入 + #21 字段 fixture scorer/双源 shape gate 已落;传输层定案扩展桥(§38 防漂移测试把 Node 常量与扩展代码锁死);站点接口改版仍可能断(当前携程 batchSearch),真实 sf-01..08 与 ≥90% 证据待用户一次性装扩展后跑批,断时降级 `[实时API:flyai]` 主链路 |
| D-14 playwright-core 分发面(RFC) | **基本清偿 2026-08-30**:传输主载改自研扩展桥(零新依赖,node:http);puppeteer-core 降为 cdp 显式后备车道的可选依赖(动态导入+缺包优雅降级);`extension/` 进 npm files 白名单,`gotry setup` 负责落位与加载指引。**残余**:D-16 上游发布面断裂修复前,session 面在 npm 干净安装下的端到端实测未完成 |
| D-15 账本触发式后置面(ADR-15 TS-5) | Litestream 云备份 / cr-sqlite 多写者复制 / RFC(loopx) §6.5 claim-fence-receipt 多用户实装——仅在触发器出现时启动:第二真实用户 / 多机部署 / AaaS 立项 |
| D-16 上游 dsh 发布面断裂 | **已验证解法②并落地 2026-08-28(记忆域 lane)**:D-16 前提有误——npmjs 上 dsh-scope **有完整 0.1.x**(0.1.1-rc.2 在列;lane 查的是滞后的内部 bnpm 镜像)。根 dependencies 已显式钉 `dsh-scope@0.1.1-rc.2`,干净安装实测:ERESOLVE 仅降级为 warning、ledger/index/dsh-tools 全部 import OK、五导出齐(AuthoritativeEntries 等)。rc.10 已发布(founder 确认制下 agent 执行:web 登录 + 浏览器二次验证,恢复码被 npm 拒收改用 web OTP 通道)。**2026-08-29 增补**:dsh 家族 0.1.2-alpha.1 不发 npm 的堵点对 repo 工作副本已解除——`ts/dsh-runtime/vendor/` 全量 vendored 源码 tarball(上游 GitHub tag 构建,workspace 成员解析);发布面收敛为单点残余:npm 公共分发面(root deps)仍钉 rc.2,上游 publish 0.1.2.x 后升版即可关闭 |
| D-17 Z3 WASM race(README Known limitation) | **已清偿 2026-08-29**(`z3-shared.ts`):双重根因一并关闭——①三模块(engine/journey/unified)各自 `init()` 使单进程并存 2-3 份 WASM 实例(内存放大,系统压力下 2GB 堆分配失败的 OOM 形态);②`engine.solve` 用 `Promise.all` 多候选并发共享同一 Context,z3 async 会话交错即栈损坏(`mk_bool_var memory access out of bounds`,run-all §1 长期靠「重试一次」止血)。现三入口经 `withZ3` 会话级互斥(单实例单 Context,门内禁嵌套),rc.4 当年单例回滚的「Context mismatch」源于残留自建 Context 混用,现无混用面;run-all §1 止血退役,新增 §30 并发回归闸(进程内三形态同轮并发 ×12 与顺序基线逐项对账) | `z3-shared.ts`;run-all §30 |
| D-18 M3 Exit 真实 cohort 证据缺口 | **进行中(Issue #22)**:公开面已有冻结 manifest、严格脱敏 schema、确定性 scorer 与 synthetic fixture 守门；nightly real-LLM 证据生产器已进入工程面(封存 prompt 集/价表、无凭证 waiting 零写入、预算闸),验收⑥「nightly 可复跑」的机械前提已就位,真实 nightly 记录待凭证环境真跑。私有真实样本尚未进入 `ts/gotry-state/evidence/m3/`。只有 50–200 人真实 cohort 同时达到定稿率 ≥40%、NPS ≥40、POI 幻觉率 <1% 且窗口内 nightly real-LLM 可复跑,才允许业务达标;无样本时不关闭 M3 Exit。 | `product-metrics.ts`;`nightly-evidence.ts`;run-all §33/§35 |
| D-19 M4 真实 repeat cohort 缺口 | **证据合同已落地 2026-08-29**:Issue #20 fixture scorer 固定 paired/active-planning/reflux/溯源/P4 口径,synthetic fixture 不得充当 Exit。赎回条件=私有 `observed_private` cohort 达 N≥5 并产出脱敏 summary;无真实样本时 waiting/backoff/no-spend,不扩 schema 假装进展。 |
| D-20 六状态面里程碑口径漂移 | **已清偿 2026-08-29(Issue #19)**:六状态面统一为「M3 真实 evidence 未收口；M4 为 founder 授权并行，不是 M3 Exit 证明；M5/M6 仅受各自 Entry gate 开闸」。后续不得把工程交付、发布或并行切片等同于里程碑退出证据。 |
| D-21 async 非 4/4 被误结算为成功 | **已清偿 2026-08-29(Issue #19)**:`collectDeepPlanning` 产出 `gotry_async_terminal.v1`；collector 仅在 4/4 时写 `succeeded`/ledger `settled`/exit 0，任一未达写 `failed`/ledger `failed`/exit 2；账本保存结构化结果，终态复诵零重算且保持同一退出码。隔离 `stateRoot` 回归见 run-all §28。 |
| D-22 pending_writes 空 receipt 无物理 CHECK(booking_saga_fsm.v1 已知边界) | 词汇层审计链已兜住(`sagaTraceViolations` 对空 receipt 报违例,run-all §36);**赎回时机 = M5 Entry 拍板**:pending_writes 随 schema 升版加 `receipt 非空 CHECK` + 具名 seam 词汇冻结(`booking-saga-fsm.md` §4),未到 M5 Entry 不动写路径 |
| D-23 效应解译器迁移未完成(ADR-18) | **部分清偿**:词汇层+生产/mock 解译器+韧性横切已落地,五工具(flyai/hotel/session/weather/flight_verify)与 realtime-pricing 默认查询口已走 `interpretEffect`;`anything/web_search/video_subtitle/github_search/agent_reach/session_login` 等其余渠道工具仍直连能力层(同款永不抛错契约,无退避/熔断/mock 面)。按渠道逐个搬,搬一个删一横切;全部走通即抄销 | `ts/capabilities/effect.ts`;`docs/effect-interpreter.md` §4;run-all §37 |

## 11. 保鲜机制(文档与现实的同步纪律)

**状态面清单**(全仓只有这 6 处记载「当前状态」,其余文档一律状态让渡):① 本文 §1 当前形态;② 本文 §9 演进;③ 本文 §10 债务清单;④ `roadmap.md` 当前位置;⑤ `README.md` 当前形态;⑥ `stage1-top-down-design.md` 状态头。

**同提交同步规则**:任何改变系统当前形态/状态/债务的提交,必须在同一提交内同步全部状态面——`bb880f3`(M1 exit)只改了 §1 与 ADR 表,四处状态面滞后了一个提交周期,本节由此而立。

**M-exit 保鲜清单**(里程碑退出提交的勾稽项,结果附于提交信息):
1. 6 处状态面全部同步(或显式让渡并注明让渡对象);
2. ADR 全表逐条过「淘汰/复审条件」,触发的当即立项或改状态;
3. 债务清单勾销与新增——债务只能在本表诞生,不许只活在代码注释里;
4. 计数类表述(ADR 数、测试数)改为引用而非数字——数字会腐烂;
5. 验收证据可复跑:夹具/脚本命令写进提交信息。

**复审节奏**:不靠日历,靠事件——M-exit 必审全表;淘汰条件被触发(求解 >500ms、差分 20 次无分歧、桥延迟 >500ms)随时审。

## 12. 文档地图

| 文档 | 关注点 |
|---|---|
| `roadmap.md` | **时间线唯一来源**:M0-M6 里程碑三线视图与旧模型归并 |
| `data-sources.md` | **数据源唯一权威面**:领域矩阵/四层架构/Google Place 链路/证据链契约/TREK 参考 |
| `tokens.md` | **token 唯一权威面**:npm 三路径(web会话/granular bypass/OIDC)+ agent-reach 8 渠道获取表 + 统一 .env 存放 |
| `tech-strategy.md` | 技术选型与半年迭代路线(M2–M4):选型矩阵/评测体系/分工/持续优化回路/决策登记 |
| 本文 | 技术:系统/模块/模型/循环/数据概要/ADR/演进/债务 |
| `gotry-master-outline.md` | 程序:工作分解/复用矩阵/决策门(总纲) |
| `gotry-product-design.md` | 产品:主循环/透明机制/全成本/共享经验 |
| `stage1-top-down-design.md` | Stage 1 详细设计与实现序 |
| `kimi-postmortem.md` | 反例教材与地面真值提取 |
| `demo-plan-2026-07-17.md` `demo-reconciliation.md` | demo 交付物与对账 |
| `dsh-plugins-shortlist.md` | dsh 社区插件选型(awesome-dsh-plugin 全量调研,issue #9) |
| `deerflow-research.md` | DeerFlow 研究 → gotry 优化目标 T1-T4(issue #10) |
| `maka-research.md` | Apache Maka(Incubating)研究 → 与 ADR-15 事务化状态基座逐项对照(durable-execution 机制/可采纳面,研究底稿供 founder 拍板) |
| `hotelbyte-skills-design.md` | hotelbyte-skills 架构(知识进仓/执行留 gotry,issue #5) |
| `e2e-prompts.md` | dsh 端到端真 LLM 验证记录(§1-§11,wrapper/澄清卡/背景调查等) |
| `memory-design.md` | **记忆域设计**:C 端六层重设计(M1-M6 现状映射/P1-P4 分期增量/铁律与验收),M4 交付「六层框架重设计」的正式文档 |
| `loopx-inspired-upgrades-rfc.md` | **RFC(accepted 2026-08-27)**:loopx 13 篇架构 RFC 的映射升级——四道接缝(S1 工具 packet 纪律/S2 记忆效用 sidecar/S3 wish 触达 0..1 纪律/S4 WriteGate L0-L4 词汇) |
| `transactional-state-rfc.md` | **RFC(accepted 2026-08-28,ADR-15)**:事务化状态基座——业界 durable-execution 调研收敛五件套 + GoTry 落地架构 + TS-0..TS-5 执行计划与决策记录(D1-D5) |
| `booking-saga-fsm.md` | **预订 saga 状态机设计(issue #17 采纳,ADR-17)**:booking_saga_fsm.v1 字母表/边表/拒绝闭集 + 三种边型词汇(deterministic/gate/external-event)+ HITL 审批的挂起-恢复形态 + M5 启封增量与不引入编排框架的判定记录 |
| `effect-interpreter.md` | **效应解译器设计(issue #16 采纳,ADR-18)**:effect_interpreter.v1 词汇(效应值/EffectOutcome/trace)+ 渠道韧性策略表(退避/断路/节律依据逐行)+ 生产/mock 双解译器 + 为什么不做视觉 CUA 与自动多渠道路由的判定记录 + D-23 迁移面 |
