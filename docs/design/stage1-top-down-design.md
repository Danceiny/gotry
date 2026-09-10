# Stage 1 顶层设计:自顶向下(契约 → 循环 → 智能接真)

> **状态速览**:
- 2026-09-10 起,PR #327 修订收紧 embedded planner 的重复 tool-call 参数恢复:普通单对象继续走 `JSON.parse`,仅恢复至少两个完整、仅空白分隔且深结构相等的顶层对象；前缀/尾部垃圾/截断/冲突/非对象序列/单个非法对象 fail-closed,字符串花括号与转义由边界扫描正确处理。公共 runPort fixture 仅是确定性本地证据,不构成真实 provider reliability、HotelByte UAT、M3/M4 cohort 或 M5/M6 admission。
- 2026-09-10 起,#329 收紧同步 Booking HTTP 409 dispatch rejection 日志:stderr 只含 typed `code` 与 exact closed `reason`,unknown/带 suffix 统一为 `UNCLASSIFIED`,公共 HTTP + 子进程 stderr proof 仅为确定性离线证据,不构成真实 provider reliability、HotelByte UAT、M3/M4 cohort 或 M5/M6 admission。
- 2026-09-10 起,#270 按 `../ops/external-pr-workflow.md` §0 统一公开 issue 启动→Draft PR→exact-head review→merge/destination 回执,并让 `../architecture.md` §10.1 活跃债务指向公开 tracker/触发器;founder 授权的仓内 Claude lane 不受外部机器人 T0/T1 否决,但仍过正常评审。本地/fixture 证明不改变 #20/#22/#136/#137 的真实 gate。
- 2026-09-10 起,#284 `gotry_doctor action=repair` 形成诊断→item 范围计划→会话 scope 审批→既有 bootstrap 幂等安装器→实际复检链;拒绝/取消/无审批通道零执行,user-action/unavailable 不越权,侧栏报告写复检态。隔离 fixture 工具 E2E 属 M4 UX 工程证据,不计入 #20 真实 repeat cohort 或 M5/M6 gate。
- 2026-09-10 起,#279 携程机票 batchSearch 解析/搜索边界区分合法空 `miss`、有效 `hit` 与 malformed `error`,扩展/CDP 两车道保留 challenge 优先级;隔离 fixture 仅证明本地解析/编排,不满足 #272 live interface calibration、真实 supplier evidence 或 M4/M5/M6 admission。
- 2026-09-09 起,#283 酒店日期闸复用共享 `parseAbsoluteDate` 的真实日历校验,并在酒店消费边界拒缺失日期、溢出和错误顺序；失败不 dispatch 并返回 `input_required`。权威说明见 `docs/architecture.md` §1.2/§10 D-36 与 issue #283；该隔离工程证据不构成真实供应商准入。
- 2026-09-09 起,#290 公开契约兼容:persona 经 `personaPrefix` / `personaSuffix` 投射(legacy `persona:` 不投影);桥 handler 结构性归类(`timed_out` / `spawn_failed` / `runner_failed`);详见 `docs/architecture.md` §9。不宣称 release/publication、M5/M6 entry、Windows 执行或真实 supplier/HotelByte 准入。
- 2026-09-10 起,#271 外层 liveness 收口：GoTry launcher 将 dsh child 放入独立 POSIX process group；exit/error/close（含继承 stdio 的 delayed close）与 parent-only SIGINT/SIGTERM 经过 bounded TERM→KILL，确认 direct child/group 清空后保留原始终止语义，既有 incident observer/writer 仍是唯一记录面；benchmark 零退出继续走原 stdout drain/parser。Node24 真实安装版本 dsh `0.1.5-alpha.1` 的维护 proof 由实际 package-shaped `bin/gotry-inner.js` 覆盖非零、正常零退出和 TERM-resistant descendant，并保留 child crash、rejected promise、spawn ENOENT、SIGINT/SIGTERM，核对 parent/leader outcome、stderr、产品 incident、post-failure marker 与 before/after descendant/group 清理。dsh SDK direct transport、内部 supervisor 和真实 deployment contract 仍是开放 TODO；本切片不改 vendor/lock、不安装 daemon、不提升任何真实里程碑 gate。
- 2026-09-09 起,#282 Booking planner 纠偏：嵌入式 read-action planner 保留非空 occupancy 房间及 childAges，缺 `adults` 继续 schema 校验；纠偏提示计入同一最多三次 provider budget，valid correction 沿同一 authority path 返回，provider failure 透传。focused proof 使用注入 runPort，真实供应商库存/UAT 仍开放。
- 2026-09-09 起,Node 26 dist 构建兼容(issue #265,M4 开源/发布质量线):支持下界保持 `>=22.15.0`;根构建只用精确 TypeScript 5.9.3 生成 ESM,CI 在 Node 22/24 保持 typecheck + 全栈回归并另以 Node 22/24/26 focused proof 核对 exact source→dist、JS/Python/data 资产、无相对 `.ts` specifier/无 CommonJS emit wrapper、skeleton-check 与关键动态 import。该项不计入 #20 的真实 repeat-cohort,也不满足 #136 供应协议/内部授权或 #137 P6 批准与真实试点；三项 gate 仍开放。
- 2026-09-09 起,web 启动交互式 onboarding(issue #258/#267,M4 UX 工程面,D-34 清偿;#267 = #266 合并后的 post-merge 加固):`npx @danceiny/gotry web` 启动前的可选能力配置(每次符合条件的启动评估一次、至多问一次,无跨启动持久确认),复用 `doctor --fix` 幂等安装器;仅交互式 TTY + 有 auto 缺项时问一次(三态结果),无 auto 但有 reportable 缺项(如 win32 无自动安装面)时渲染分类计划 + 具体原因、不 prompt 不安装、`reported` 抑制重复 detached 摘要;CI/非 TTY/全健康/opt-out 零 prompt 零安装仍启 web;`installerEnabled` 注入 env,纯函数全链不依赖 ambient。#267 加固:web-onboarding 子调用改 awaited POSIX process-group `spawn`(SIGINT/SIGTERM 可服务,信号路径清 result+patch 目录),bootstrap installer `run()` 也有 bounded process-group lifecycle;outer grace 覆盖 installer TERM+SIGKILL budget。结果通道 0700 `mkdtemp` + `0600/wx`,bootstrap-tests §21 跨过真实 inner→bootstrap onboarding 进程边界,§21c/§21f/§21g 覆盖 prompt-wait、accepted-install parent signal 与 accepted-install timeout 清理。M4 UX 质量线,不计入 #20 真实 `observed_private` cohort Exit。
- 2026-09-08 起,dsh-map-tools runtime 回归修复(issue #242):#239 误用 alpha.3 不存在的 `installSettingsSection/settingsNamespace` 导出使真实安装包插件 import 失败；现恢复普通 namespace 字符串与 `ctx.inject(['settings'], scope => scope.settings.installSection(...))` 接线,打包 proof 钉 7 个 `map_*` 工具、settings watch/reload/dispose 与禁网 inline 坐标路径。
- 2026-09-08 起,ADR-16 tenant scope 修复(issue #224):账本 `insertEvent` 写当前 tenant,`readEvents`/fold/rebuild 全带 tenant 条件,legacy/v1 只迁入 `local`;跨租户同 id/idem_key、交错 update、A rebuild 不影响 B/local、跨进程 reopen 已由 ledger-tests/booking-saga-tests 钉住。历史已误写为 `local` 的非 local 事件不自动猜修。
- 2026-09-10 起,#254 只读修复计划:复制 db/`-wal`/`-shm` 到临时目录后盘点,复制前后与读取结束对账源字节,变化即 fail-closed;显式证据映射才可计划搬移。未 checkpoint WAL 与 v1 零目录写均由隔离测试覆盖;apply/迁移/backup/rollback/真实回执仍是 #254 后续子项,不构成 M5/M6 gate。
- 2026-09-08 起,state-cli 租户参数边界(issue #226/#241):账本 CLI 集中解析 cmd/positional/`--state-root`/`--tenant`/`--limit`,未知/重复/缺值/非法 numeric(含 `.5`/`+.5`)先于任何 state-root 副作用 fail-closed;#241/#243 已入 main并关闭;`tick`/`export`/`whatif` 明确 local-only,`whatif` 仅是整库管理员 snapshot,不是租户导出。
- 2026-09-08 起,M4→M6 program 任务图(issue #225):M4 scorer/显式同意 collector、tenant ledger/CLI、Z3 与 map 稳定性基座已入 main,#227/#241/#242 已关闭;真实 M3/M4 cohort、#136 供应协议/内部授权、#137 P6 批准与真实试点仍为 TODO。`milestone-delivery-plan.md` 继续给出责任面/E2E/否证/退出标准;`write-gate-production-design.md` 仅为 proposal,不启封交易或 B2B 实现。
- 2026-09-06 起,Round 9 治理面(issue #100/#102):LLM_MAX_TOKENS 注入 llm-deepseek 目录 maxTokens(修真实中转模型 2013)+ GOTRY_BENCHMARK_SOFT_MS/HARD_MS 预算按 run 可配(缺省 60/120s 不变);治疗首次全链路存活,余量为预算内收敛。
- 2026-09-08 起,Round 10 将 Round 8 的 flat `tools|call|errors` discovery/recovery 面与 owner-local per-tool v3 descriptor 合流：每工具 exact input schema 同时约束模型和 spawn，result/domain/failure envelope 与最新-response terminal fence fail-closed；provider/scorer/evaluator/default product path 不变，冻结 treatment 与 score 仍待独立证据。
- 2026-09-08 起,Round 10 real `glm-5.3-flash` treatment（main `c843fae`）诊断出 provider/model visibility failure：顶层 `oneOf` wire schema 导致 57 次空 `{}` 调用，无 countable score；Round 11 仅将模型面对的 bridge wire 展平为 `action=tools|call|errors`、descriptor-derived `tool` enum 与 generic object `arguments`，执行时仍 exact 校验冻结 descriptor `input_schema`。
- 2026-09-05 起,指标面板第一切片(issue #138):`build-metrics-report.ts` 只读聚合既有侧车(事实闸 verdict 分布与 blocked 率/通道健康/事故面/桥延迟 >500ms 复审锚点/账本与 doctor 报告存在性)成单一 markdown;工程面,不构成 M3 Exit 证据(归 #22)。
- 2026-09-05 起,政策事实生产端 v1(issue #141,D-26):VISA_POLICY_FETCH effect 注册表行,C 档中国领事服务网国家指南树,礼貌抓取→PolicyFact 落账;founder 拍板 C 档路线,Timatic/Sherpa° 后议。
- 2026-09-04 起,事实闸覆盖面(issue #118,D-26 收口):HotelFact 第三形态(exact-date 酒店检索落账,摸底/传输失败/打码价纪律同机火)+ gotry_fact_gate 酒店 claim 入闸 + 渲染原语单向生成(renderFlightFact/renderHotelFact 内嵌 fact 锚点,闸侧锚点优先确定性回溯);政策生产端(实时签证 API)仍记 D-26 外部依赖。
- 2026-09-10 起,事实闸覆盖面政策渲染锚点闭合(issue #273,D-26 残余收口切片):renderPolicyFact 行内嵌 fact 锚点(与机/火/酒店同源 typed-anchor),闸侧锚点确定性回溯,手改/伪造锚点 = fact_anchor_unknown;锚点行 as_of 内容指纹仅核对「截至日期」(改写或删除日期而保留 fact_id 同源 fail-closed),不宣称封闭 statement 全文或所有事实漂移;POLICY_WORD 补「海关申报」(与「入境申报」同性质但被原 regex 漏掉),手写政策行缺 as_of → policy_without_as_of。fact-gate-tests §11 八断言(64 pass)。
- 2026-09-04 起,legacy vendored dsh 回退移除(issue #120,D-27 清偿):dsh 解析只认 root manifest/依赖闭包,找不到即 fail-closed 报错指重装;DshRuntime.source 收敛 'root'。
- 2026-09-04 起,needs-extension 文案自适应(issue #117,D-24 清偿):按本地通道落位自动跳过开发者模式/本地通道指引——商店版用户只推商店一键装与「已装即可」;桥失败摘要与 doctor 扩展项同步自适应。
- 2026-09-09 起,会话检索面新增 dida 供应商门户适配器(`gotry_session_search kind=dida`,SESSION_DIDA_SEARCH 效应注册表行)——解译器平铺纪律照旧,无新策略表形态;详见 `../architecture.md` §9。本设计原文(Stage 0-4 求解/编排)不受影响,状态让渡回 architecture §9。
- 2026-09-10 起,#308 forward fix 固化会话 kind 选择：gate 与 execute 共用 `interpretArgs` query-first 语义,缺省为 flight,unknown/malformed fail-closed;train 公开查询面仍受 sessionAccess 的 off/ask/allow 与按站点拒绝/取消约束。回归入口为 session-tests §I + smoke §13。
- 2026-09-04 起,解译器迁移收尾(issue #115,D-23):anything/web/github/video/agent_reach/session_login 六渠道入效应注册表,23 工具外部依赖面全收敛 effect_interpreter.v1(没有策略表行就没有效应);工具面照旧平铺,证据链逐源标注不变。
- 2026-09-04 起,启动一次性 doctor 摘要(issue #114):web/headless 启动时分离子进程后台只读体检,待处理项一行 stderr(全 ok 静默/零写盘/不阻塞/benchmark 豁免)——初始化可见取代会话中段撞错。
- 2026-09-04 起,工具描述首行由通道注册表生成(issue #113):七个检索工具描述前置「服务意图 × 通道顺位」卡(与失败现场 routing 字段同表),doctor 补齐 patch 宿主插件 dsh-map-tools/dsh-tool-ask-user 两态；map-tools 当前由 `ts/dsh-runtime/vendor/dsh-map-tools/` 以 MIT payload 随包交付，外部 npm 依赖因 rc peer 与 alpha.3 closure 冲突而移除。
- 2026-09-04 起,typed 参数契约迁移(issue #112,D-30,五刀收官):全部 23 个注册工具参数面 blob → dsh typed ParameterSchemaSpec 平铺/结构化字段,模型可见逐字段 JSON Schema;刀法总纲=有 required 字段的工具宿主权拒畸形参数(ToolFailure 形状不变;evidence 类 P0 红线进 schema 由宿主权闸),全可选工具保留 interpretArgs 容忍层;迁移锁 smoke §1/§6/§12/channel-registry-tests §8;普通模型 canary 已跑(10/10 一次成型,2026-09-04),D-30 全面清偿。
- 2026-09-04 起,行为契约 22 条(横评反哺,issue #121/#122):(1) 动机先行扩展同行人到达链访谈(见面/汇合类必问,问明落 `gotry_companion_save`,分链核算)+ 新增 (22) 到达账必达(红眼/落地即消耗航段显式给到达账);出处与评分卡见 `docs/evaluation/persona-bench/`。
- 2026-09-08 起,澄清卡示例过锚点卡(issue #2 rc18 复发):(8) 内部澄清——澄清卡/访谈/选项里向用户列出的候选时段示例(节日/周末/月份)同样只取今天之后的,已过的节日不进示例枚举;契约仍 22 条,persona-surface-guard-tests 4/4 钉回归(run-all §54)。
- 2026-09-08 起,行为契约 22→23 条(新增 (23) 子任务等待纪律,issue #194 B-轨道):continuable 子代理回执 id 不是 job id,禁对子代理调 job_output/job_kill,完成通知自动送达、追加输入用 send_message;persona-surface-guard-tests 5/5。
- 2026-09-03 起,检索通道编排收敛为通道注册表 + 健康面(ADR-25,issue #106/#107/#108):persona 路由卡 `{{channel_routing_card}}` 与工具结果内 `routing` 建议由 `channel-registry.ts` 生成,本文涉及 persona (19) 工具枚举的表述以该卡为准;dsh-calendar 默认不挂载(D-9)。
- S2 mock 切片 ✅ / S3 求解挂载 ✅ / S4 真 LLM ✅(MiniMax-M2,`bb880f3`)/ S5 编排+持久化 ✅(详见 `../architecture.md` §9,那里是唯一的当前状态源);本文保留设计原文供追溯。**M1/M2 已退出；M3 工程面已就绪但真实种子用户 evidence 未收口，M3 Exit 仍开放；M4 由 founder 授权并行推进,#20/#223 scorer 与 #228 lifecycle collector 均为工程证据面,不构成 M3 Exit 证明；M5/M6 仍受各自 Entry gate 约束。
- HotelByte Booking Copilot 是独立的产品验收并行线：GoTry 以单一 `booking.surface` 契约（2026-09-05 #133 收敛，原 v2 形态转正、v1 退役）的 BFF-only typed read-action planner 提供协作面——六个生命周期阶段、七个 phase 字面值（`terminal`/`error` 是两种终态结果）的 durable projection，生产 standalone 默认只接受 BFF 已绑定的 `user.turn`/receipt continuation，完整 principal + binding seam 才开放 `user.turn.ingress`。部署候选绑定 exact SHA/schema/Linux Node 24+ABI provenance，并从鉴权 health 回显实际进程 identity 与 ingress mode；它不暴露 `Book`、不启封 M5。tenant/customer/storefront/payment-link 的真实库存与 unavailable/changed 恢复链仍待 UAT，因此保持 Draft、不可合并。
- Discussion #78 的 external benchmark 反馈已进入 S5 编排边界:每轮第 16 次真实工具派发注入软收敛,第 18 次是最后一个 body,同一步第 19 次起结构化拒绝；该批 `step/end` 后下一次 native request 抑制继承工具 schema。run-all §45 以 Cordis contracts + npm-mode dist/dsh headless 离线 E2E 固定真实 runtime 行为,CI 另由当前 SHA tarball 的隔离 pnpm consumer 入口重放。Round 1 的 exact DeepSeek 为 environment unavailable/schema-invalid 0，GLM 为 300s timeout；Round 2 唯一冻结 treatment 只到 diagnostic-only。Round 3 聚焦 CLI→native 调用与 tagged-JSON 终态 conformance，但新冻结 treatment 在 runner 单次派发后 planner/runner exit 1、0 字节终态、evaluator 未进入。Round 4 treatment（SHA `5ebddb2(重写后 0e93eae)`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，释放 0 字节，evaluator 未进入；产品 gate 使用 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c(重写后 7d6f8a9)`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属，不把离线 E2E 宣称为 benchmark 改善。
- Phase 1 environment bridge 当前态:default-off owner-local v3 descriptor 的模型可见 wire 为 flat `action=tools|call|errors`；`tool` 枚举由 descriptor 派生，`arguments` 是 generic object，`tools` 做 discovery，`errors` 返回闭合的 bridge protocol/infrastructure recovery inventory。执行时仍 exact 校验冻结 descriptor `input_schema`，模型面与 spawn 前 validator 的职责边界不变。adapter 只接受 exact `gotry_benchmark_tool_result_v1`：concrete result 受非空 `output_keys` 正向键合同约束，finite exact `domain_outcomes` 以 exit 0 进入模型历史，非零退出仍是 infrastructure failure；bridge 不自动 retry。conformance 以最新 bridge response 作为 tagged terminal 时序下界，旧终态不能遮蔽后续 domain/failure。cold-start、headless one-shot、native definition-only、host-enforced writes/network isolation 与 default-off 产品边界不变；当前没有可归因 official score/uplift。
- Round 5 runtime resolution:source checkout 与 clean package 都解析同一组 230 个精确直接依赖的 DSH `0.1.5-alpha.1` closure（2026-09-09 issue #268 从 `0.1.2-alpha.3` 216 包闭包精确迁移:15 新增 sentinel + 移除 `dsh-tool-subagent-report`，全部 230 个 `@deepseek-ai/dsh*` 包钉死精确版本，拒绝 `^0.1.5-alpha.1` 匹配 `0.1.5-alpha.2` 的 semver 预发布漂移；CI `npm ci --strict-peer-deps` / pnpm `--strict-peer-dependencies` 显式严格；run-all §23a-§23e 五个确定性证明。设置行为不变；尚未发布 tag 或 npm 版本；这些确定性证明不构成 M5/M6 准入）；manifest、package-lock 与 root pnpm importer 的 DSH 名称集合必须同为 230，publish preverify 对漏钉、混版或 range 声明 fail-closed。source 普通运行的 dsh cwd 保持 `ts/dsh-runtime/`，状态继续落 `ts/dsh-runtime/gotry-state/`，benchmark opt-in 与 npm package 使用调用目录隔离；legacy vendored alpha.1 只作非 benchmark 解析兼容，不承诺可运行。benchmark 在 spawn 前拒绝实际 DSH 版本漂移；Node 下界统一为 22.15，并在 DSH import/spawn 前稳定拒绝旧版本。
- Round 6 terminal diagnostics:benchmark conformance 只观察最终 `turn/end`，按 allowlisted code/有限 status 映射 coarse enum；所有自由文本与 raw stderr 均不进入控制面。per-session arbiter 只在最终终态单写，bridge/conformance 专项原因优先，恢复成功的 model retry 零失败输出。代码 SHA `c61600b(重写后 ea678f8)` 的 ChinaTravel frozen treatment（`..._00001`，`deepseek-v4-flash`）在 49.546 秒后稳定输出 `child_runtime_error`，但仍为 0 terminal bytes、evaluator/official scores null；leakage 与本地凭证/端点扫描均为 0。该切片不改变重试、prompt、工具和评分逻辑，不产生 uplift。
- Round 7 minimal kernel:代码 SHA `edb9392896625adbb48abae4a2ecf968dbfc0349` 的 benchmark opt-in 仅保留 turn deadline(产品路径默认不装;benchmark opt-in 装 wall-clock 闸)、model override、唯一 bridge、isolation/conformance；产品 prompt variables/process guards/consent/普通工具均不装，默认路径不变。system-prompt 投影为稳定 task-agnostic persona，root patch 只接受 canonical `insert` 与 `system-prompt` 各一，其他 root item/变体 fail-closed。ChinaTravel frozen treatment UID `e20241028160248698752`（`easy`，`deepseek-v4-flash`）preflight pass、未回退，80.463s 后 runner exit 1、terminal 0 bytes/invalid，evaluator 未进入、official null、不可计分；白名单归因为 `child_bridge_runner_failed`，不产生 uplift 或 external benchmark closure。该问题已由 Round 8 的 generic bridge actions/recovery inventory 接续。
- **2026-08-27 起,①③ 两环的时间语义由 `ts/src/time-anchor.ts` 锚点卡供给(ADR-12),本文①中「2026 年历」的硬编码表述以锚点层为准。
- 2026-08-28 起,S5 工单持久化升级为账本 durable 形态(ADR-15:workflow_runs/steps 权威 + json/md 视图),本文工单文件表述以 `state-ledger.ts` 为准；`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0，将非 4/4 映射为 `failed`/ledger `failed`/exit 2，终态复诵保持同一结果与退出码且零重算。2026-08-29 起,求解运行时收敛 `z3-shared.ts`(单一 WASM 实例+会话级互斥,run-all §30 并发回归闸)——
- Z3 WASM race 已知限制首轮清偿。2026-09-08 #227 复修:Node24 全栈 §30 间歇 heap corruption 的新增根因为冷初始化 Promise 缓存竞态 + `z3-solver@5.2.0` high-level `FinalizationRegistry` native cleanup 越过 `withZ3`；本轮补 low-level cleanup 局部队列 + actual native check barrier + fatal poison,确定性守卫进入 run-all §30b、多进程重复进入 §30c。2026-08-29 同批:④中 dated 段经 `realtime-pricing.ts` 实时价覆写(env 闸默认关,证据 `[实时API:flyai@ts]`),run-all §31。同批:i18n catalog 接缝(`i18n.ts`,`GOTRY_LOCALE` 默认 zh-CN,金标准逐字节不变),求解确定性面英文可用,run-all §32。
- 同日第二批:OTA 工具面平铺(`gotry_flyai_search` kind=hotel 接入飞猪 `search-hotel`,OTA 工具描述与 persona (19) 去「三级路由/主链路」层级)+ 账号会话工具授权闸(`tools/pre-execute`→dsh 原生审批卡,每会话首次调用请求、会话内记住、拒绝即本会话吊销,`sessionAccess: ask|allow|off` 总闸随时可关,smoke §12-13/session-tests §I)+ 登录产品化(第 18 工具 `gotry_session_login`:needs-login 时 agent 直调,在用户 Chrome 弹登录页、等其在携程官网完成登录,无需终端;
- gotry 只读票据 cookie 名零值过手,登录引导页不挂 ReadGuard 为唯一豁免面),session-tests §J)。
- M3 Issue #22 的 evidence manifest、脱敏 schema 与 scorer 已进入工程面，真实 50–200 人 cohort 未进入私有证据面，M3 Exit 仍开放；2026-08-29 同日第二批:nightly real-LLM 证据生产器 `ts/scripts/nightly-evidence.ts`(封存 prompt 集+封存价表 peak 保守换算,无凭证 waiting/backoff/no-spend 零写入,预算闸超限退 3,run-all §35)就位,验收⑥机械前提闭合,真实 nightly 记录待凭证环境真跑;
- 会话数据面 #21 已有字段 fixture scorer/双源合同与 waiting-attach no-spend 确定性闸，真实浏览器验收状态让渡 `../rfc/user-session-data-rfc.md`;2026-08-30 传输层定案扩展桥(MV3 一次性安装替代逐连接 CDP 弹窗,`needs-extension`/`waiting_extension` no-spend,真实 sf-01..08 门禁=装一次扩展,run-all §38)。
- 2026-08-30 同批 onboarding UX 闭环(issue #21 P3.6,后于 2026-09-02 商店上架后撤销,§3.3 职责返交):`npx @danceiny/gotry setup wizard` 单命令 + 跨平台 GUI 面板(macOS osascript / Linux zenity / Windows msg / headless 终端)+ 后台 health-watch ≤120s 自动重放同 query_id,用户侧初版曾降到 3 次点击 + 0 次终端命令 + 装完零重跑(撤销后由 dsh UI verdict.installUrl 接管渲染,用户进一步降到 1 次点击:Chrome 商店「添加至 Chrome」);
- `ts/capabilities/session/{wizard,health-watch}.ts` + `scripts/health-watch-cli.ts` + bootstrap `wizard` 子命令;run-all §40 onboarding-tests 9/9 + bootstrap-tests 7/7 wizard 节。
- 2026-08-30 同批,issue #46(P0 事实性):可下单事实收敛单一数据源 `gotry_bookable_fact.v1`(exact-date 工具结果 hit/miss 落账,miss 禁回填),交付含可下单事实的产物前必过第 21 工具 `gotry_fact_gate`(ADR-19,run-all §39,smoke §16),本文工具清单一节状态让渡 `../architecture.md` §3。2026-08-30 同批,issue #21 分发通道(ADR-21):扩展产物分发双通道——
- GitHub Releases 下载通道已落(`--extension-from=github` 显式 opt-in,SHA256+key 钉扎+失败降级 bundled,run-all §43);Chrome Web Store 已上架(2026-09-02 v0.1.0,一键装+自动更新=推荐安装面;商店重签 key ⇒ 商店版扩展 ID 独立,桥 Origin 白名单双通道同信,`docs/ops/extension-webstore-submission.md`;D-25 已清偿)。
- 2026-08-30 同批,issue #49(价表 v2 + 价格漂移长机制,ADR-20):封存价表从 `gotry_llm_price_table_v1` 升 `v2`(provider-aware:DeepSeek tiered_peak_offpeak + MiniMax flat_no_offpeak,MiniMax M2/M2.1/M3 入表,M3 取 >512k tokens 档作为 peak ceiling 守 ADR-11「peak only-high-not-low」);
- 价格漂移监测 `ts/scripts/price-drift-watch.ts` + `tests`(覆盖 DeepSeek/MiniMax/OpenAI/Anthropic 四家主流 provider,默认离线对照 baseline fixture 比对输出 PR-就绪 Markdown diff 含 model/field/from/to/direction 四向,`--fetch` 拉取官方页 + 首次写 fixture,**永不自动 apply 价格**——价格调整走 PR + 人 review);run-all §41 合同验证 8/8。
- 2026-08-30 同批,issue #77(P2 配置面):三件套 `.env` 的 `LLM_MODEL` 接通 dsh 会话面——bin 映射 `GOTRY_LLM_MODEL` + gotry-tools 插件 `agent/request` 瀑布内存覆盖(dsh settings 用户层 ~/.dsh 优先于 composition 层,单靠 patch 压不过;覆盖零持久化不改写用户设置)+ 运行时 cordis patch by-id 双覆盖(`agent-default-model` 默认模型 + `llm-deepseek` 目录);
- 不设 `LLM_MODEL` 零行为变化,.env.example 默认行注释化;E2E `ts/scripts/model-override-e2e.ts` 四场景(mock 中转+隔离 DSH_HOME+current tarball clean installed-package bin)全绿，不再靠移动源码依赖伪装 package mode；smoke §17。
> **M4 Issue #20/#223/#228**:
- paired-cohort/active-planning/experience-reflux synthetic fixture scorer 已进入 run-all §34；#223 加固为逐层 exact schema、HMAC-SHA256 假名键、N=5/median reduction=0.5 阈值冻结(raw ratio 比较,报告才 round)、observed-private source-review attestation + `reviewed_summary_digest_sha256` 绑定合同。#228 collector 只在显式 stateRoot/consent/HMAC 下记录首返 flow、外部 wait、reflux 与 preference,导出 candidate/synthetic scorer 输入,不制造 manual attestation。它们只证明证据合同与采集路径，真实 `observed_private` N≥5 repeat cohort + 人工核验合同仍是 Exit 前置，不得反推 M3 Exit。2026-08-29 起,本文输入案例的工具链可用性语义以 `capabilities/` 与安装期自举为准(Issue #24:weather 地理编码双源兜底/flyai 过去日期预校验+miss/error 分陈述/hbcli 官方方式自举+静态包按目的地过滤降级)。
- 2026-08-29 起,工单交付与工作目录产物可在 dsh 内直接查看(`gotry_artifacts_list/read`),并有宿主侧栏工作台渲染(dsh-better-sidebar,`gotry setup` 安装)。2026-08-29 同批,issue #16 采纳:外部渠道收敛效应解译层 `effect_interpreter.v1`(ADR-18,`capabilities/effect.ts`+`resilience.ts`)——
- 指数退避重试/断路器/mock 解译器按 per-效应策略表统一执行(默认全关零行为变化),flyai/hotel/session/weather/flight_verify 与 realtime-pricing 查询口已走 `interpretEffect`,余下渠道增量迁移(D-23),run-all §37;工具面照旧平铺,证据链逐源标注不变,本文工具清单一节状态让渡 `../architecture.md` §3 与 `effect-interpreter.md`。
> **Issue #67 会话 benchmark 状态**:`sf-live-benchmark --golden=static` 以 OpenFlights 固定修订提供 route/carrier,以手工 manifest 提供估算时刻/价格带；evidence 显式记录 requested/effective source、provenance、estimated fields 与 fallback reason。静态源失败会 stderr 告警并回退 manual,不伪装成实时班期/票价/库存；真实会话侧仍依赖用户 Chrome 扩展。离线合同归 run-all §44。
> **Issue #67 真跑边界与桥生命周期**:已登录 Chrome 连续两轮 static official 均 8/8 hit、fallback 0;session 分别 3/8 与 5/8 hit,全部可评分 hit(3+5 条)均 13/13=100%,非 hit 均显式 miss。这证明软评分 ≥90% 与来源可审计,不证明 8/8 可售性。默认桥已对空闲 parked timer/socket `unref`,wizard `keepBridge` 不变;§38 24/24、§40 9/9。

> Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures/test-only aggregate admission plus a deterministic PR/nightly/weekly/milestone cadence policy/planner. It returns admission, `pass^k`, budgets, calibration, failure-registry, and cross-benchmark synthesis obligations only; it has no scheduler, external launch, spend, score, Agent-round, or uplift effect. No Python runtime dependency, baseline, or matched production evidence is included.
> 创始人指令(第三次纠偏):自顶向下实现,不要自底向上打磨细节。
> 本文档是 Stage 1 的**唯一权威设计**;一切实现工作从这里派生,叶子(求解器/引擎)已就位,缺的是树干。
> 关键架构判断先行:**对话循环的架构验证不需要 DEEPSEEK_API_KEY——用 mock LLM 先行,API key 只解锁智能质量,不阻塞架构。** 此前「Stage 1 全阻塞在 key」是误判。

## 1. 顶层黑盒:一次会话的系统行为

输入(用户第一句,真实案例):
> 7.17周五22:40落地深圳,7.18早上去香港办银行开户&保险签约;……8.10周一凌晨从深圳起飞,周一上班前到迪拜。请给我做机票和酒店的行程规划和推荐。

系统必须在一轮内完成(Kimi 用 13 轮搞砸的事):

```
用户消息 ──► ① 日历/事实断言(2026 年历,星期映射只算一次,永久进状态)
          ──► ② 访谈补全(缺什么问什么:工作时间?已订资源?同行人?预算档?)
          ──► ③ JourneySpec 抽取(自然语言 → 统一模型,LLM 的翻译责任)
          ──► ④ 求解(unified 引擎,确定性责任:锚点/工作窗口/全成本/wish pool)
          ──► ⑤ 渲染(透明卡片+全成本表+gates 选择题,LLM 解释+模板)
          ──► ⑥ 复杂时:异步(「一小时后回来看看」,loopx tick)
```

②是增量追问而非重来;③④⑤每轮可重入(用户改一个答案,只重跑受影响的段)。**状态在,人不充当系统部件。**

## 2. 第一层分解:组件契约

### 2.1 会话状态 TripState(顶层数据契约,一切组件围绕它读写)

```ts
TripState = {
  calendar: { year: 2026, assertedWeekdays: {...} }        // ① 的产物,一次断言终身使用
  profile: { workWindow?, companions?, budgetTier?, ... }  // ② 的产物(Kimi 复盘:这两个曾最晚出现)
  spec?: JourneySpec                                       // ③ 的产物(统一模型,已存在)
  solve?: SolveResult                                      // ④ 的产物(已存在:verdicts/exclusions/red_flags)
  gates: Gate[]                                            // ⑤ 的待决问题(选择题)
  wishes: WishEntry[]                                      // 「下一次出发」
}
```

### 2.2 工具面(L2 契约;dsh 插件注册,已有 3 个,补 2 个)

| 工具 | 责任归属 | 状态 |
|---|---|---|
| `gotry_interview_next(TripState) → Question[]` | 确定性(缺失字段驱动,非 LLM 即兴) | **待定义** |
| `gotry_spec_extract(对话历史) → JourneySpec` | LLM(翻译) | **待定义**(dsh 运行时内) |
| `gotry_solve(JourneySpec) → SolveResult` | 确定性(已实现:unified) | ✅ |
| `gotry_render(SolveResult) → 卡片/表格/gates` | 模板+LLM 润色 | 部分(answer_md 已有) |
| `gotry_wish_pool_add` / `gotry_motivation_save` | 确定性 | ✅(插件已有) |

责任铁律不变:LLM 只做 ②的问句组织、③的翻译、⑤的解释;**判定与算术永远是确定性组件**。

### 2.3 对话循环(L2 编排契约)

```
loop:
  msg ← user
  state ← TripState.load(session)
  ①若新事实与 calendar/profile 冲突 → 指出并确认(不静默重排)
  ②qs = interview_next(state);若 qs 非空且 msg 未回答 → 追问(增量)
  ③spec = spec_extract(history + state)     // LLM
  ④state.solve = solve(spec)                // 确定性
  ⑤reply = render(state.solve) + gates      // LLM+模板
  TripState.save(state); → reply
```

## 3. 自顶向下实现顺序(每步有独立验收,叶子最后才动)

| 步 | 做什么 | 验收 | 依赖 |
|---|---|---|---|
| S1 | **契约冻结**:TripState 与 5 工具的 schema(TS 类型 + JSON Schema)落 `ts/src/contracts.ts` | 契约走查通过(创始人评审一次) | 无 |
| S2 | **mock 垂直切片**:mock-LLM(确定性脚本:读剧本回放 Kimi 对话的用户侧输入)+ 真工具面 → 跑通 §2.3 循环 | 用你的原始开场白重放:系统主动问出工作窗口与已订酒店,日历一次断言,产出规划与 gates——**全程零 API key** | S1 |
| S3 | 求解器挂载(把已完成的 unified 作为 gotry_solve 的实现接入循环) | 重放输出与当前 demo 规划书等价 | S2 |
| S4 | 真 LLM 接入(dsh 运行时 + DEEPSEEK_API_KEY) | 同一开场白,真实对话质量 ≥ mock 重放(Kimi 复盘的验收标准) | S2+key |
| S5 | 异步模式真实化(loopx tick 驱动「一小时后」) | 不失望四条在真对话里成立 | S4 |

**这个顺序把「等 key」从架构阻塞降级为 S4 的质量变量:S1-S3 全部可以现在做。**

## 4. 新增 ADR

- **ADR-8(mock-LLM 先行)**:对话循环的架构验证用确定性剧本 LLM,不依赖真实模型;智能质量与架构正确性解耦。淘汰条件:S4 完成后 mock 保留为回归夹具。
- **ADR-9(访谈确定性)**:`interview_next` 由缺失字段驱动(配置化问题库),LLM 只润色问句——Kimi 的「从不访谈」病根是即兴,确定性驱动是解药。

## 5. 与债务/阶段的关系

- D-3(LLM 未进环)分解为:S1-S3(架构,可动)+ S4(智能,等 key)——债务的「架构一半」不再阻塞。
- D-4(界面)维持 Stage 1 后;本设计的 L1 就是「对话即界面」, gates 以消息内选择题呈现。
- 现有 unified 求解器/数据包/插件 = 本设计的叶子,零返工。
