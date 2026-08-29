# 效应解译器 effect_interpreter.v1(设计文档,issue #16 采纳,ADR-18)

> 状态:accepted(2026-08-29)。词汇层+生产/mock 双解译器+垂直切片已落地;smoke/run-all §37 是锚点。
> 关联:`architecture.md` §8 ADR-18;`data-sources.md`(数据源权威面);`tool-packet.ts`(ADR-13,工具边界同思想的先行件)。

## 1. 问题(issue #16 原文拆解)

issue #16「多渠道比价与外部依赖隔离」提出三件事:

1. **效应描述与解译器分离**:agent 不直接调用 `Ctrip.Query()`,而是输出纯数据效应
   `{ "effect": "SEARCH_FLIGHT", "params": {...} }`;
2. **多环境解译器**:生产解译器(真调 API,带指数退避重试/断路器/速率限制)、
   浏览器+CUA 解译器(browser-use 操作 OTA 界面,插件化开源)、mock 解译器(CI/本地无网);
3. 落点:多渠道比价的架构前置。

## 2. 判定(逐条:采纳/修正/不采纳)

- **采纳(效应即数据)**:本仓已有同思想先例——工具边界的 packet 纪律(ADR-13,
  `tool-packet.ts`,loopx effect-interpreter 映射)与 LLM 端的 `LlmPort`(mock-llm vs
  dsh-llm)。但**渠道侧没有统一 seam**:每个工具 execute 直连能力层函数,
  fetch/spawn/超时/降级/证据横切逻辑各家复制。本设计把「效应值 + 解译器」下沉到
  L4(`ts/capabilities/effect.ts`),词汇名 `effect_interpreter.v1`。
- **采纳(韧性横切进解译层)**:指数退避重试 + 断路器落地为
  `ts/capabilities/resilience.ts`,由 **per-效应策略表**显式拍板,**默认全关零行为变化**;
  速率限制不新建——会话面节律闸(session-search §3.4,≥30s)本就存在于渠道内,
  不在本层重复实现。
- **修正(浏览器/CUA 解译器)**:视觉点击 CUA 不做——零 Python 依赖(repo 红线)判死
  Python browser-use;检索面 a11y/DOM 优先(user-session-data-rfc)亦排除视觉自动化。
  浏览器解译采纳为 **SESSION_\* 效应**:用户本人 Chrome 的 CDP attach + ReadGuard
  (物理写拦截)+ 账号授权闸(session-consent)。issue 设想的「长尾场景插件化」
  由 adapter 形态(session/adapters/*)承接,不引入第二浏览器运行时。
- **不采纳(自动多渠道路由)**:解译器**不做**渠道间自动路由/降级排序/比价聚合——
  OTA 工具面平铺与「无预设路由优先级」是 founder 判定(persona 19/architecture §9
 第二批);比价发生在 agent 层(多工具并调+证据链逐源标注)。多渠道比价由此
  获得**架构前置**(每条通道可替换/可熔断/可 mock),而非本层实现比价逻辑。

## 3. 词汇(effect_interpreter.v1)

```
效应值(纯数据):  { effect: string, params: unknown }          // GotryEffect
解译产物:          { result: 渠道自有 observation | null,       // EffectOutcome(不重包,ADR-13 面不受扰)
                     trace:  { attempts, backoffMs, breaker, declined?, evidence[] } }
拒绝面(平铺):     declinedObservation(): { ok:false, verdict:'error', summary, evidence }
```

- 解译器接口 `EffectInterpreter = (fx: GotryEffect) => Promise<EffectOutcome>`:
  - **生产解译器** `makeProductionInterpreter({ handlers?, breakers?, now?, sleep? })`:
    查注册表 → 断路器闸 → `withRetry`(指数退避,base×2^(n-1) 封顶)→ 渠道 handler
    (现能力层函数,零改写)→ 渠道 observation 原样透传 + trace 横切证据
    `[效应:<NAME>@ts] attempts=… backoff=… breaker=…`;
  - **mock 解译器** `makeMockInterpreter(fixtures)`:夹具回放,确定性零网络——渠道
    observation 的录制形态即回放形态(与 mock-llm 同思想的第三个成员);CI/离线巡检
    「不联网跑全链」即此通道;
  - `selectInterpreter('production'|'mock')` 多环境注入。
- **断路器语义**(CircuitBreaker,resilience.ts):closed→(连续失败达阈值,一次调用
  一次计数,重试耗尽才计)→open(零执行成本拒绝,不抛错)→ 冷却满 → half-open 单
  探测(成功→closed 清零;失败→重开冷却重启)。状态是**进程内瞬态**(同 session
  节律闸先例),不落盘成持久资产;测试用注入时钟/即时 sleep 完全确定性。
- **重试语义**:只重试「瞬时类」失败(超时/网络断/socket);上游明确说「不」的失败
  (FlyAI Sentinel 限流)与 ENOENT 类必败失败永不重试——重试是放大器不是修复器。

### 渠道韧性策略表(权威面,代码即实现 `SPECS`)

| 效应 | 渠道 | 重试 | 断路器 | 节律/授权 | 依据 |
|---|---|---|---|---|---|
| `FLYAI_SEARCH` | cli | 瞬时类 2 次/500ms 起 | 3 连错/开 60s | – | data-sources §8:Sentinel 限流绝不硬重试;熔断保护未公布配额 |
| `HBCLI_HOTEL_SEARCH` | cli | 永不(1 次) | 3 连错/开 60s | – | hbcli 契约「候选路径是切换不是重试」 |
| `HBCLI_HOTEL_RATES` | cli | 永不(1 次) | 3 连错/开 60s | – | 同 HBCLI 族;价格面**无静态降级 fail-closed**(不估算房价,与 bookable-facts 证据分级同口径) |
| `HBCLI_CHECK_AVAIL` | cli | 永不(1 次) | 3 连错/开 60s | – | 同上;验价不可用即诚实失败(预订链下单前置,M0) |
| `SESSION_FLIGHT_SEARCH` | browser | **永不** | **不参与** | 渠道内 ≥30s 节律闸 + 账号授权闸 | 风控/挑战=「上游说不」,重试即红线;needs-login/cooldown 是状态不是故障 |
| `WEATHER_GEOCODE/FORECAST/CLIMATE` | api | 2 次/400ms | 3 连错/开 30s | – | 免费源瞬时抖动重试合法,熔断防免费配额空转 |
| `OPENSKY_FLIGHT_VERIFY` | api | 2 次/400ms | 3 连错/开 30s | – | 同上(~400 credits/天) |

新增效应 = 注册表加一行 handler + SPECS 加一行策略 + 测试 §37 加断言;**没有策略
表行就没有效应**——韧性是显式拍板,不是默认继承。

## 4. 落点与迁移面(截至本提交)

已接(生产解译器单例,断路状态随进程存活):

- 工具五件:`gotry_flyai_search` / `gotry_hotel_search` / `gotry_session_search` /
  `gotry_weather_check` / `gotry_flight_verify`(index.ts execute 全部改经
  `interpretEffect`;断路/未注册拒绝返回平铺失败面,不伪装成 miss);
- 求解链:`realtime-pricing.ts` 默认查询口(`RealtimeQueryPort` 注入面不变,
  默认实现改走解译器——多段行程连查自动获得退避+熔断)。

未接(债务 D-23,迁移路径=按渠道逐个搬,搬一个删一横切):`gotry_anything_search`、
`gotry_web_search`、`gotry_video_subtitle`、`gotry_github_search`、`gotry_agent_reach`、
`gotry_session_login` 等其余渠道工具仍直连能力层(它们享有同款永不抛错契约,但尚无
退避/熔断/mock 夹具)。

## 5. 测试与锚点

`ts/scripts/effect-tests.ts`(run-all §37,纯离线):注册表封闭性/退避封顶链与记账/
断路三态(时钟注入)/Sentinel 不重试但计熔断/熔断零执行拒绝+冷却单探测恢复/mock 夹
具回放/SESSION 红线(永不重试不熔断)/真实 handler 静态包降级冒烟(自定义不存在 bin,
零网络)。

## 6. 与既有词表的关系

- ADR-13(工具 packet 纪律):工具边界的 effect_request→interpretation→observation
  在 dsh 已存在;本层是**渠道边界**的同构下沉,两者不冲突(工具面照旧平铺);
- M5 WriteGate(ADR-15 pending_writes saga / ADR-17 booking_saga_fsm.v1):写效应
  (预订/支付)未来若入解译器注册表,必须走 booking_saga_fsm.v1 边表——本词汇层
  只覆盖读效应,不构成 M5 里程碑证据;
- 复用矩阵:解译器是 gotry 自有代码,无外部代码引入;mock 通道与 flyai/hbcli 测试
  已有的假 CLI 注入形态**层次不同、互不取代**——假 CLI 在 handler 内部(替换内核
  进程),解译器 mock 在 handler 边界(替换整支渠道),CI 无网跑全链用后者。