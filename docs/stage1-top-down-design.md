# Stage 1 顶层设计:自顶向下(契约 → 循环 → 智能接真)

> **状态速览**:
- S2 mock 切片 ✅ / S3 求解挂载 ✅ / S4 真 LLM ✅(MiniMax-M2,`bb880f3`)/ S5 编排+持久化 ✅(详见 `architecture.md` §9,那里是唯一的当前状态源);本文保留设计原文供追溯。**M1/M2 已退出；M3 工程面已就绪但真实种子用户 evidence 未收口，M3 Exit 仍开放；M4 由 founder 授权并行推进，不构成 M3 Exit 证明；M5/M6 仍受各自 Entry gate 约束。
- HotelByte Booking Copilot 是独立的产品验收并行线：GoTry 仅承担 BFF-only typed read-action planner，部署候选绑定 exact SHA/schema/Linux Node 24+ABI provenance，并从鉴权 health 回显实际进程 identity；它不暴露 `Book`、不启封 M5。tenant/customer/storefront/payment-link 的真实库存与 unavailable/changed 恢复链仍待 UAT，因此保持 Draft、不可合并。
- Discussion #78 的 external benchmark 反馈已进入 S5 编排边界:每轮第 16 次真实工具派发注入软收敛,第 18 次是最后一个 body,同一步第 19 次起结构化拒绝；该批 `step/end` 后下一次 native request 抑制继承工具 schema。run-all §45 以 Cordis contracts + npm-mode dist/dsh headless 离线 E2E 固定真实 runtime 行为,CI 另由当前 SHA tarball 的隔离 pnpm consumer 入口重放。现有 ChinaTravel runner 尚未加载 GoTry treatment,冻结 timeout case 与原 5-query manifest 仍待 treatment-attested adapter 后外部回归,不得把离线 runtime E2E 宣称为 benchmark 改善。
- ** 2026-08-27 起,①③ 两环的时间语义由 `ts/src/time-anchor.ts` 锚点卡供给(ADR-12),本文①中「2026 年历」的硬编码表述以锚点层为准。
- 2026-08-28 起,S5 工单持久化升级为账本 durable 形态(ADR-15:workflow_runs/steps 权威 + json/md 视图),本文工单文件表述以 `state-ledger.ts` 为准；`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0，将非 4/4 映射为 `failed`/ledger `failed`/exit 2，终态复诵保持同一结果与退出码且零重算。2026-08-29 起,求解运行时收敛 `z3-shared.ts`(单一 WASM 实例+会话级互斥,run-all §30 并发回归闸)——
- Z3 WASM race 已知限制清偿。2026-08-29 同批:④中 dated 段经 `realtime-pricing.ts` 实时价覆写(env 闸默认关,证据 `[实时API:flyai@ts]`),run-all §31。同批:i18n catalog 接缝(`i18n.ts`,`GOTRY_LOCALE` 默认 zh-CN,金标准逐字节不变),求解确定性面英文可用,run-all §32。
- 同日第二批:OTA 工具面平铺(`gotry_flyai_search` kind=hotel 接入飞猪 `search-hotel`,OTA 工具描述与 persona (19) 去「三级路由/主链路」层级)+ 账号会话工具授权闸(`tools/pre-execute`→dsh 原生审批卡,每会话首次调用请求、会话内记住、拒绝即本会话吊销,`sessionAccess: ask|allow|off` 总闸随时可关,smoke §12-13/session-tests §I)+ 登录产品化(第 18 工具 `gotry_session_login`:needs-login 时 agent 直调,在用户 Chrome 弹登录页、等其在携程官网完成登录,无需终端;
- gotry 只读票据 cookie 名零值过手,登录引导页不挂 ReadGuard 为唯一豁免面),session-tests §J)。
- M3 Issue #22 的 evidence manifest、脱敏 schema 与 scorer 已进入工程面，真实 50–200 人 cohort 未进入私有证据面，M3 Exit 仍开放；2026-08-29 同日第二批:nightly real-LLM 证据生产器 `ts/scripts/nightly-evidence.ts`(封存 prompt 集+封存价表 peak 保守换算,无凭证 waiting/backoff/no-spend 零写入,预算闸超限退 3,run-all §35)就位,验收⑥机械前提闭合,真实 nightly 记录待凭证环境真跑;
- 会话数据面 #21 已有字段 fixture scorer/双源合同与 waiting-attach no-spend 确定性闸，真实浏览器验收状态让渡 `user-session-data-rfc.md`;2026-08-30 传输层定案扩展桥(MV3 一次性安装替代逐连接 CDP 弹窗,`needs-extension`/`waiting_extension` no-spend,真实 sf-01..08 门禁=装一次扩展,run-all §38)。
- 2026-08-30 同批 onboarding UX 闭环(issue #21 P3.6):`npx gotry setup wizard` 单命令 + 跨平台 GUI 面板(macOS osascript / Linux zenity / Windows msg / headless 终端)+ 后台 health-watch ≤120s 自动重放同 query_id,用户侧 3 次点击 + 0 次终端命令 + 装完零重跑;
- `ts/capabilities/session/{wizard,health-watch}.ts` + `scripts/health-watch-cli.ts` + bootstrap `wizard` 子命令;run-all §40 onboarding-tests 9/9 + bootstrap-tests 7/7 wizard 节。
- 2026-08-30 同批,issue #46(P0 事实性):可下单事实收敛单一数据源 `gotry_bookable_fact.v1`(exact-date 工具结果 hit/miss 落账,miss 禁回填),交付含可下单事实的产物前必过第 21 工具 `gotry_fact_gate`(ADR-19,run-all §39,smoke §16),本文工具清单一节状态让渡 `architecture.md` §3。2026-08-30 同批,issue #21 分发通道(ADR-21):扩展产物分发双通道——
- GitHub Releases 下载通道已落(`--extension-from=github` 显式 opt-in,SHA256+key 钉扎+失败降级 bundled,run-all §43),Chrome Web Store 上架材料就绪待 founder 提交(`docs/extension-webstore-submission.md`,D-25)。
- 2026-08-30 同批,issue #49(价表 v2 + 价格漂移长机制,ADR-20):封存价表从 `gotry_llm_price_table_v1` 升 `v2`(provider-aware:DeepSeek tiered_peak_offpeak + MiniMax flat_no_offpeak,MiniMax M2/M2.1/M3 入表,M3 取 >512k tokens 档作为 peak ceiling 守 ADR-11「peak only-high-not-low」);
- 价格漂移监测 `ts/scripts/price-drift-watch.ts` + `tests`(覆盖 DeepSeek/MiniMax/OpenAI/Anthropic 四家主流 provider,默认离线对照 baseline fixture 比对输出 PR-就绪 Markdown diff 含 model/field/from/to/direction 四向,`--fetch` 拉取官方页 + 首次写 fixture,**永不自动 apply 价格**——价格调整走 PR + 人 review);run-all §41 合同验证 8/8。
- 2026-08-30 同批,issue #77(P2 配置面):三件套 `.env` 的 `LLM_MODEL` 接通 dsh 会话面——bin 映射 `GOTRY_LLM_MODEL` + gotry-tools 插件 `agent/request` 瀑布内存覆盖(dsh settings 用户层 ~/.dsh 优先于 composition 层,单靠 patch 压不过;覆盖零持久化不改写用户设置)+ 运行时 cordis patch by-id 双覆盖(`agent-default-model` 默认模型 + `llm-deepseek` 目录);
- 不设 `LLM_MODEL` 零行为变化,.env.example 默认行注释化;E2E `ts/scripts/model-override-e2e.ts` 四场景(mock 中转+隔离 DSH_HOME+npm 发布形态)全绿,smoke §17。
> **M4 Issue #20**:
- paired-cohort/active-planning/experience-reflux synthetic fixture scorer 已进入 run-all §34；它只证明证据合同，真实 `observed_private` N≥5 repeat cohort 仍是 Exit 前置，不得反推 M3 Exit。2026-08-29 起,本文输入案例的工具链可用性语义以 `capabilities/` 与安装期自举为准(Issue #24:weather 地理编码双源兜底/flyai 过去日期预校验+miss/error 分陈述/hbcli 官方方式自举+静态包按目的地过滤降级)。
- 2026-08-29 起,工单交付与工作目录产物可在 dsh 内直接查看(`gotry_artifacts_list/read`),并有宿主侧栏工作台渲染(dsh-better-sidebar,`gotry setup` 安装)。2026-08-29 同批,issue #16 采纳:外部渠道收敛效应解译层 `effect_interpreter.v1`(ADR-18,`capabilities/effect.ts`+`resilience.ts`)——
- 指数退避重试/断路器/mock 解译器按 per-效应策略表统一执行(默认全关零行为变化),flyai/hotel/session/weather/flight_verify 与 realtime-pricing 查询口已走 `interpretEffect`,余下渠道增量迁移(D-23),run-all §37;工具面照旧平铺,证据链逐源标注不变,本文工具清单一节状态让渡 `architecture.md` §3 与 `effect-interpreter.md`。
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

## 修订史

| v1.0 | 2026-08-22 | 创始人三次纠偏(架构优先→自顶向下)后立项:黑盒行为/契约/mock 先行/五步实现序/ADR-8/9 |
