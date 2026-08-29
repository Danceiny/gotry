# Stage 1 顶层设计:自顶向下(契约 → 循环 → 智能接真)

> **状态速览**:S2 mock 切片 ✅ / S3 求解挂载 ✅ / S4 真 LLM ✅(MiniMax-M2,`bb880f3`)/ S5 编排+持久化 ✅(详见 `architecture.md` §9,那里是唯一的当前状态源);本文保留设计原文供追溯。**M1/M2 已退出；M3 工程面已就绪但真实种子用户 evidence 未收口，M3 Exit 仍开放；M4 由 founder 授权并行推进，不构成 M3 Exit 证明；M5/M6 仍受各自 Entry gate 约束。** 2026-08-27 起,①③ 两环的时间语义由 `ts/src/time-anchor.ts` 锚点卡供给(ADR-12),本文①中「2026 年历」的硬编码表述以锚点层为准。2026-08-28 起,S5 工单持久化升级为账本 durable 形态(ADR-15:workflow_runs/steps 权威 + json/md 视图),本文工单文件表述以 `state-ledger.ts` 为准；`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0，将非 4/4 映射为 `failed`/ledger `failed`/exit 2，终态复诵保持同一结果与退出码且零重算。2026-08-29 起,求解运行时收敛 `z3-shared.ts`(单一 WASM 实例+会话级互斥,run-all §30 并发回归闸)——Z3 WASM race 已知限制清偿。2026-08-29 同批:④中 dated 段经 `realtime-pricing.ts` 实时价覆写(env 闸默认关,证据 `[实时API:flyai@ts]`),run-all §31。同批:i18n catalog 接缝(`i18n.ts`,`GOTRY_LOCALE` 默认 zh-CN,金标准逐字节不变),求解确定性面英文可用,run-all §32。同日第二批:OTA 工具面平铺(`gotry_flyai_search` kind=hotel 接入飞猪 `search-hotel`,OTA 工具描述与 persona (19) 去「三级路由/主链路」层级)+ 账号会话工具授权闸(`tools/pre-execute`→dsh 原生审批卡,每会话首次调用请求、会话内记住、拒绝即本会话吊销,`sessionAccess: ask|allow|off` 总闸随时可关,smoke §12-13/session-tests §I)+ 登录产品化(第 18 工具 `gotry_session_login`:needs-login 时 agent 直调,在用户 Chrome 弹登录页、等其在携程官网完成登录,无需终端;gotry 只读票据 cookie 名零值过手,登录引导页不挂 ReadGuard 为唯一豁免面),session-tests §J)。M3 Issue #22 的 evidence manifest、脱敏 schema 与 scorer 已进入工程面，真实 50–200 人 cohort 未进入私有证据面，M3 Exit 仍开放；2026-08-29 同日第二批:nightly real-LLM 证据生产器 `ts/scripts/nightly-evidence.ts`(封存 prompt 集+封存价表 peak 保守换算,无凭证 waiting/backoff/no-spend 零写入,预算闸超限退 3,run-all §35)就位,验收⑥机械前提闭合,真实 nightly 记录待凭证环境真跑;会话数据面 #21 已有字段 fixture scorer/双源合同与 waiting-attach no-spend 确定性闸，真实浏览器验收状态让渡 `user-session-data-rfc.md`。
> **M4 Issue #20**:paired-cohort/active-planning/experience-reflux synthetic fixture scorer 已进入 run-all §34；它只证明证据合同，真实 `observed_private` N≥5 repeat cohort 仍是 Exit 前置，不得反推 M3 Exit。2026-08-29 起,本文输入案例的工具链可用性语义以 `capabilities/` 与安装期自举为准(Issue #24:weather 地理编码双源兜底/flyai 过去日期预校验+miss/error 分陈述/hbcli 官方方式自举+静态包按目的地过滤降级)。 2026-08-29 起,工单交付与工作目录产物可在 dsh 内直接查看(`gotry_artifacts_list/read`),并有宿主侧栏工作台渲染(dsh-better-sidebar,`gotry setup` 安装)。2026-08-29 同批,issue #16 采纳:外部渠道收敛效应解译层 `effect_interpreter.v1`(ADR-18,`capabilities/effect.ts`+`resilience.ts`)——指数退避重试/断路器/mock 解译器按 per-效应策略表统一执行(默认全关零行为变化),flyai/hotel/session/weather/flight_verify 与 realtime-pricing 查询口已走 `interpretEffect`,余下渠道增量迁移(D-23),run-all §37;工具面照旧平铺,证据链逐源标注不变,本文工具清单一节状态让渡 `architecture.md` §3 与 `effect-interpreter.md`。

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
