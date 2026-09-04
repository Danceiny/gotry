# Session 适配器作者指南(D-13)

> 定位:**给"要接入一个新站点/新通道"的人的工程手册**。适配器是本仓工具生态的扩展单元
> (tool-orchestration-design §5③):新增站点不触核心,只加「适配器 + 注册表行 + 测试」。
> 模板 = **12306 第一方校准法**(2026-09-03 实证落地:电报码表官方站表全量校准 129 城、
> 座位桶索引对齐,曾纠出南宁 NIZ→NNZ 错码——见 `capabilities/session/adapters/rail-12306.ts`)。
> 关联:`data-sources.md`(数据源权威面/站点矩阵)、`user-session-data-rfc.md`(会话面 RFC)、
> `benchmark.ts`(双源 shape gate)、run-all §38/§41。

## 0. 一条铁律:适配器在传输层**只读**

扩展桥(GoTry Session Bridge)从不替站点发请求——它只被动转发**站点自己的查询响应**
(`session-bridge.v1` job 协议);gotry 永不接触凭证/验证码,挑战页即停(`challenged`)。
任何"帮用户把请求发出去"的设计都是越界,评审直接拒。

## 1. 四步法(12306 模板)

### 第一步:探测(发现站点的公开查询面)

- 找站点**公开查询接口**(12306 余票查询、携程酒店 list 页)——不需要登录的面优先,
  登录态面走授权闸(见 §3 纪律 3)。
- 沉淀 **NETWORK_HINTS 词表**(如 `ctrip-flight.ts` 的 `NETWORK_HINTS`):用于扩展侧
  判断"这个响应是检索结果"(URL/字段名/主机名匹配),词表越准误报越少。
- 记录请求参数与响应 shape 的**人工核验笔记**(后续 fixture 的溯源材料)。
- 站点专有词汇(电报码/城市 id/座位桶)先抄官方站面,标 `as_of` 日期。

### 第二步:第一方金标准 fixture

- 用**真会话**实测一次,把响应冻结为 fixture,**逐字段可溯源**
  (参照 `ts/data/golden-trip-2027-facts.json` 的 fixture meta 思想:来源/取数时刻/审计值)。
- 站点专有映射**全量对照官方站表**,不做抽样(12306 电报码 129 城全量校准就是这么
  抓出 NIZ→NNZ 的)。映射常量进适配器(`STATION_TELECODES` 形态),与官方站表
  逐条核对后冻结。
- 枚举映射(座位桶 `cN`→席别、座型码)同样逐项对照,锁进适配器常量。

### 第三步:双源 shape gate

- 实现站点结果 → `SessionComparableRecord`(`benchmark.ts`,`session-double-source.v1`)
  的映射,必填字段见 `REQUIRED_COMPARABLE_FIELDS`。
- 用 `scoreSessionFixture` 对 fixture 打分:**字段级准确率 ≥ 0.9 才算校准通过**
  (`SESSION_FIELD_ACCURACY_THRESHOLD`)——"看着对"不算,字段对才算。
- verdict 八值分型(`hit/miss/error/challenged/cooldown/needs-login/needs-extension/…`)
  必须逐个给出判定依据并在测试里各有一例;**传输失败永不落负事实**(ADR-19)。

### 第四步:漂移锁

- 站点专有映射 = **防漂移断言**进测试(数量断言 + 抽样关键字段断言,如
  "电报码表 ≥129 城 且 南宁=NNZ"):站点改版会在 CI 红,而不是在用户会话里哑败。
- fixture 评分 ≥0.9 断言进 run-all(§38 扩展桥/§41 会话面锚点同族)。
- 会随时间腐烂的事实(政策/班期)带 `review_by` 复核 gate(ADR-19 纪律)。

## 2. 新适配器接入清单(文件级)

| 动作 | 文件 |
|---|---|
| 适配器本体(词汇表/URL 构造/响应归一) | `ts/capabilities/session/adapters/<site>.ts` |
| 效应注册表:handler + 策略表行(D-23 后:没有策略表行就没有效应) | `ts/capabilities/effect.ts`(`DEFAULT_HANDLERS` + `SPECS`) |
| 通道注册表行(id/意图/配额类/证据级/setup) | `ts/capabilities/channel-registry.ts`(`CHANNELS`) |
| 工具分支或检索入口 + verdict 分型渲染 | `ts/src/index.ts` |
| fixtures + 评分断言 + 漂移锁 | `ts/scripts/session-*-tests.ts` / fixtures 目录 |
| 数据源矩阵行 + 校准实录 | `docs/data-sources.md` |

不加策略表行/注册表行的"顺手接一个通道"在评审即打回:通道健康面、routing 建议、
doctor 行全部由注册表生成,表外通道=对模型不可见且不可审计。

## 3. 纪律清单(红线,逐条评审)

1. **只读传输**:扩展 never issues requests(§0 铁律);适配器不写任何站点状态。
2. **节律闸**:同站点两次检索 ≥30s(`session-search` 内建),适配器不得绕过。
3. **授权闸**:登录态面必须过 `sessionAccess` 审批卡(每会话每站点首次弹卡、拒绝即
   本会话吊销);公开查询面(12306)不需要。
4. **challenged 即停**:验证码/风控页 = 上游说不,永不重试(效应策略表 `retry: null`)。
5. **凭证零过手**:登录只读票据 cookie **名**(`LOGIN_COOKIE_NAMES`),永不读值;
   登录永远发生在站点官网,`gotry_session_login` 只做引导与确认。
6. **打码价保真**:上游打码的价格(`priceRaw` "¥7xx")原样保留、不得切零伪装真价;
   数字价仅在站点明示时落字段(hotel fact 不落数字价,D-26)。
7. **证据链逐源标注**:每条结果带 `[会话:<site>@ts]` 同款 evidence;负事实/error 分开
   陈述,不混写"无结果或失败"。
8. **效果注册表纪律**:退避/熔断策略行逐条拍板(透传面永不重试;timeout 类才可重试)。

## 4. 携程接口面真会话校准清单(D-13 遗留,执行依赖 founder 登录)

> 前置:`scripts/session-login.ts` 完成携程真登录(顺带同窗口登录美团)——该 founder
> 动作已挂在 `gotry-session-data-goal` 的 user todo,校准执行与它同窗口做。

- [ ] **ctrip-flight**:`batchSearch` 响应 shape 逐字段对照 fixture(字段名/价格字段/
  时刻时区),双源评分 ≥0.9。
- [ ] **ctrip-hotel**:list 页 `cityId` 码表扩容核对(码表外城市走 web 搜索指引的
  覆盖率抽查);`roomInfo[].priceInfo.price` 路径回归(2026-09-03 第一方校准 a0cd1ad)。
- [ ] **meituan-local**(民宿/门票):登录后 NETWORK_HINTS 实测 + 熔断冷却参数校准
  (gotry-session-data-goal P2 项)。
- [ ] **金标准 20 查询跑批**:sf-01..20 双源对照,字段级 ≥90%、live <15s 复核
  (RFC 验收口径)。
- [ ] **cookie 票据名单校准**:两侧登录后核对 `LOGIN_COOKIE_NAMES` 全覆盖、零误报。
- [ ] 校准结论回写 `docs/data-sources.md`(矩阵行 + 修订史)。

## 5. 参考:既有样板

- **rail-12306.ts**:电报码/座位桶第一方校准模板(本指南的四步法来源)。
- **ctrip-flight.ts / ctrip-hotel.ts**:NETWORK_HINTS + 登录态面 + 授权闸样板。
- **meituan-local.ts**:半成品骨架(a11y 兜底方向,待登录实测)。
- **session/benchmark.ts**:双源 shape gate 的 scorer 与阈值。
