# 工具编排与通道健康面设计(issue #106/#107/#108 收口 + 两个核心命题)

> 状态:proposal(2026-09-03)。采纳后按 §6 落地序列拆 PR,每条过全栈回归并同步六状态面;
> 拍板点汇总在 §7 与 `decisions-needed.md` D-7/D-8/D-9。
> 关联:ADR-13(工具 envelope)/ADR-18(效应解译器)/ADR-19(事实分型)/ADR-24(turn 预算);
> `effect-interpreter.md`;`data-sources.md`(数据源权威面);evaluation 轨 issue #96/#100/#102。

## 0. 这份文档回答什么

1. open issues 中全部工具调用相关问题的统一设计:#108(session bridge 优先级/工具编排)、
   #107(TOOL_BUDGET_EXHAUSTED/额度归属)、#106(初始化引导/glob 超时);并交代
   #96/#100/#102(evaluation 轨,工具契约同源)与 #82(world2agent 事件面)的关系。
2. 核心命题一:如何**长久**保持工具调用的「性能」,包括在普通 LLM 下的表现。
3. 核心命题二:如何维持工具生态开放,提供最高程度的可扩展性。

## 1. 三个 issue 的共同根因

三个 issue 的失败形态不同,根因是同一个:**失败发生的瞬间,模型手里没有结构化的
通道状态与下一步指引**——

| issue | 失败形态 | 缺失的东西 |
|---|---|---|
| #108 | flyai 429 额度尽,模型跨轮盲重试,不知道 session bridge 是更强补缺 | 通道状态(额度已尽)+ 改道指引(下一路最优通道) |
| #107 | web_fetch/flyai 撞 TOOL_BUDGET_EXHAUSTED,用户拿不到答复 | 配额的归属定义与可见性(耗尽前不可见);症状层已被 ADR-24 v2 根治 |
| #106 | dsh-calendar 会话中报「未配置 username」;glob/grep 超时 | patch 分发面宿主插件的初始化引导;glob/grep 归上游 dsh(本仓无锚点) |

现有底座(不重建,只在其上收口):

- **ADR-13 平铺 envelope**(`tool-packet.ts`):成功/失败同形,guard 兜底同形——所有工具
  返回已经是结构化载体,改道指引有地方放。
- **ADR-18 效应解译器 + 韧性策略表**(`effect.ts`/`resilience.ts`):效应即数据、per-效应
  退避/熔断显式拍板、mock 解译器;429 不重试归 needs-setup 已落地(flyai.ts)。
- **ADR-19 事实分型**(`bookable-facts.ts`):miss≠error,传输失败永不落负事实
  (issue #96 要求的不变量已实装,见 §3.4)。
- **ADR-24 v2 turn 预算**(`turn-policy.ts`):确定性路由(quick/sync/deep,零 LLM)+
  wall-clock 双出口(converge/handoff)——「预算耗尽裸死」形态已根治(#107 症状层)。
- **needs-setup verdict + 工具描述双层明示**(defeb5b):达限即给「勿重试、改走 X」指引。
- **doctor 体检面**(`capabilities/doctor.ts`):可选依赖状态与补装指引的统一出口。

根因归纳成四条缺口:

1. **通道状态是隐式的**——散落在报错文案、persona 散文、工具描述里,没有一等数据面;
2. **路由知识只在 prose 里**——persona (19) 近千字散文,强模型能读,普通模型读不动;
3. **配额不可见**——耗尽那一刻才知道,无法预empt、无法解释;
4. **初始化引导只覆盖 gotry 自有依赖**——patch 分发的宿主插件(dsh-calendar 等)在覆盖外。

## 2. 设计总览:通道注册表(数据)+ 通道健康面

两个新的一等数据面,其余全部由它们**生成**(不是新增并行真相):

### 2.1 通道注册表 `channel-registry`(纯数据,单一来源)

每行描述一条通道:

```
{ id: 'flyai' | 'session:ctrip-flight' | 'session:12306-train' | 'hbcli' | 'open-meteo' | …,
  intents: ['search-flight', …],            // 覆盖的意图(见 §3.3 意图词表)
  quotaClass: 'user-session' | 'user-key' | 'anonymous-trial' | 'free-public' | 'static',
  evidenceTier: '[实时API:*]' | '[会话:*]' | '[静态包:估算]',   // 可靠性排序依据
  setup: { surface: 'doctor#flyai' | 'extension-store' | 'cordis.patch.yml', … },
  fallbacks: ['session:ctrip-flight', 'web'],  // 同意图内的候选顺位(静态初值)
  probe?: 'doctor item id'                   // 健康探测锚点
}
```

消费方(全部生成,零手改):① persona (19) 的替换片段;② 各检索工具描述的首行
(适用意图/降级顺位);③ 工具结果里的 `routing` 建议字段(§3.3);④ doctor 报告行。
加一个通道 = 注册表加一行 + handler 一个 + 测试断言——persona/描述/doctor 随之自动一致。
这是命题二(§5)的物理基础,也是命题一「prose 会腐坏、生成物不腐坏」的落点。

### 2.2 通道健康面(channel health)

两个粒度,均从既有 verdict 流派生,不新增运行时:

- **持久面 = doctor v2**:体检项从「装没装」扩到「配额类通道现在好不好」——
  从 incident/fact 侧车读最近一次 needs-setup/429 时间,显示「今日已达限/半可用」级状态;
  并新增 patch 分发面宿主插件一节(§3.1)。
- **会话面 = session channel-state**(进程内瞬态,与断路器同先例,不落盘):
  某通道返回 needs-setup / challenged / cooldown / needs-extension 时记
  `{channel, state: down|degraded, reason, since}`;后续**同会话内**相关意图的工具结果
  尾部注入一行 `routing` 建议(见 §3.3)。turn 开始时不主动广播(不烧 token),
  只在失败现场或相关检索结果处教学——契约在失败现场教,不在系统提示里预习。

### 2.3 与 ADR-18「不做自动多渠道路由」、persona (19)「平铺无预设优先级」的兼容论证

本设计**不动**这两条 founder 判定:工具面保持平铺,解译器不做隐藏派发,模型仍然
自己选工具、自己发起调用。变化在于:排序不再是**静态预设**(那正是 persona (19) 删掉的
「三级路由」),而是**由运行时健康状态驱动的动态建议**——#108 的病灶不是「没有静态
优先级」,而是「flyai 额度耗尽这一状态变化没有任何机制传导到模型的下一次选择」。
静态平铺 + 动态建议同时满足两条历史判定(透明、可审计、agent 层比价)与本 issue
的诉求(可用性优先的编排)。备选「解译器层自动改道」仍判定不做:它破坏调用可审计性
(模型以为调了 A 实际走了 B),与 WriteGate 同构的透明原则相违。

## 3. 逐 issue 设计

### 3.1 #106 — 初始化引导扩到 patch 分发面;glob/grep 归上游

**事实纠正**:triage 称「gotry 代码面零引用 dsh-calendar」在**分发层不成立**——
`cordis.gotry-patch.yml` 第 15-16 行分发该插件,`bin/gotry-inner.js` 运行时解析并注入,
且注释明知「未配置时工具报错降级,不挡启动」。即:gotry 自愿把一个**已知未配置**的
工具发到了模型的工具箱里,报错发生在会话中段——这正是 issue ①「初始化时一并完成
安装配置」的合理诉求。triage 的 grep 范围只覆盖了 persona/工具描述/文档,未覆盖分发面。

**设计**:

1. **doctor v2 新增「宿主插件」一节**:对 patch 分发的每个宿主插件
   (dsh-calendar / dsh-map-tools / dsh-tool-ask-user)检查两态——可解析(bin 解析逻辑
   同款候选清单)+ 已配置(calendar:profile `cordis.patch.yml` 的 calendar 行 config
   是否填了 username;map-tools 零 key 可跑只查存在性);未配置给精确 fix(可复制命令
   或 patch 行示例)。doctor 只读、永不抛错的契约不变。
2. **calendar 默认不挂载**(推荐,需拍板 D-9):gotry 对 calendar 的唯一诉求是工作窗口
   读取,而 persona (1) 的访谈本就首轮必问工作窗口——未配置的 calendar 是纯负资产
   (多一个会报错的工具)。挂载与否由 **setup 状态面**管理:`~/.gotry/calendar.json`
   (与扩展 manifest 同居 `~/.gotry`),`npx gotry setup calendar` 开启 / `--off` 恢复
   默认 / `--status` 查看;**禁止环境变量控制产品行为**(founder 2026-09-03 纠偏:
   可选依赖必须进 setup 状态管理,env 不是产品开关的归宿);doctor 引导配置;
   拍板备选:保留默认挂载 + doctor 引导(治标,模型仍会撞一次报错才知道)。
3. **bootstrap 一次性摘要**:`npx gotry web`/headless 启动时跑一遍只读 doctor,
   有 degraded/missing 项就打一行摘要(不阻塞启动,不重复刷)——「初始化时可见」
   取代「会话中段撞错」。
4. **glob/grep 超时**:dsh 宿主内置工具,gotry 侧无动作锚点——维持 triage 结论,
   上游另立 issue(若仍复现)。本仓不为此设代理层(复用矩阵:harness 层是 dsh 本体)。

### 3.2 #107 — 配额归属机制(额度类工具的分类学与降级契约)

issue 的真问题(triage 已定位):**上游配额的归属与升级路径**,不是 gotry per-turn 预算
(后者已由 ADR-24 v2 收口)。

**配额五分类**(进通道注册表 `quotaClass`,每类的归属与耗尽语义一并冻结):

| 类 | 归属 | 实例 | 耗尽语义 |
|---|---|---|---|
| user-session | 用户本人账号 | session bridge(携程/12306) | 用户自己的额度;节律闸(≥30s)+ 挑战即停保护;不转嫁 |
| user-key | 用户自备 | FLYAI_API_KEY、hbcli 凭证 | 配额是用户与上游的合同;doctor 显示有效性 |
| anonymous-trial | 产品垫付的导流层 | flyai 匿名试用共享池 | **定位=首次体验,不是生产依赖**;达限即 needs-setup + 升级指引 |
| free-public | 社区公平使用 | open-meteo / OpenSky / OSRM | 熔断防空转(策略表已有);配额按天复位 |
| static | 无配额 | 内置数据包 | 估算必标注,永不冒充实时 |

**归属建议(D-7 拍板)**:正式使用一律向 user-key 或 user-session 升级;**产品统一申请
正式 key 池当前不做**——成本、滥用面、上游 ToS 三个未定量,M3 真实 cohort 规模出现时
再复审。匿名试用池保持「零摩擦首体验」定位,但其状态必须可见(doctor 配额探测,§2.2),
不再「易达限却不可见」。

**会话级降级策略**(健康面的会话面,§2.2):429/needs-setup → 本会话标记
`flyai: down(trial-exhausted)` → 同会话后续机/火/酒检索意图的工具结果注入
`routing: session → web`(§3.3)。跨会话不记忆(每次会话重探测,避免陈旧状态锁死
已补装 key 的恢复路径——恢复信号 = 下一次成功调用自动清除 down 态)。

### 3.3 #108 — 「动态规划」工具编排 = 意图×通道矩阵 × 健康态 → 建议路由

把 founder 的 DP 诉求落成可工程化的形式:

```
状态   s = 通道健康向量(§2.2 会话面)+ 配额类(§3.2)+ 各通道证据级(注册表静态)
动作   a = 为意图 i 选择通道 c ∈ channels(i)
价值   V(i,s) = lexicographic-max over c available in s of (可用性, 可靠性=证据级, 效率=成本/时延)
递推   通道间在给定健康态下相互独立 ⇒ 无跨意图耦合,最优子结构成立;
       每意图的最优 = 可用通道中按字典序取第一——DP 退化为「健康态驱动的有序建议表」
记忆化 = 会话通道状态缓存(健康态不变,建议表不重算)
```

工程形态(**建议,不是派发**):

1. **意图词表**(闭集,注册表 `intents` 的键):`search-flight | search-train | search-hotel |
   read-web | search-geo | weather | verify-flight | …`——每工具声明自己服务哪些意图。
2. **工具结果 `routing` 字段**:verdict ≠ hit 时(且仅此时),在 ADR-13 平铺 envelope 上
   追加 `routing: { intent, alternatives: [{tool, why, setup?}] }`——按当前健康态算出的
   顺位表,逐条带一句话理由(「flyai 试用额度已尽」「会话面需一次性装扩展」)。
   成功结果不带(零 token 成本);失败结果带(正是需要指引的瞬间)。
3. **persona (19) 瘦身**:近千字散文收缩为由注册表生成的紧凑片段——每意图一行
   「意图 → 通道顺位(含证据级)」,加上「verdict≠hit 时按结果内 routing 改道,
   每意图每会话至多向用户解释一次」一条规则。prose 教义变为查表教义。
4. **工具描述首行生成**:各检索工具描述开头统一为生成的「服务意图/当前顺位/不适用面」
   ——模型在选工具时(读描述)与失败后(读 routing)两个决策点都拿到同一张表。

**「session bridge 优先级太低」的精确回答**:不设静态优先级(维持 persona (19) 判定);
设**状态驱动的动态顺位**——flyai 有 key 且健康时它是首荐(零 setup 摩擦),flyai 匿名
达限的当刻 session 即升为首荐并附安装/登录指引。优先级不再是常量,是健康面的投影。

**备选与拒绝**:解译器层自动改道(隐藏派发)——拒绝,理由见 §2.3;把「额度耗尽概率」
放进 turn-policy 路由——拒绝,turn-policy 是纯函数零 IO(控制面铁律),健康态经
工具结果注入,不进分类器。

### 3.4 evaluation 轨(#96/#100/#102)与 #82 的关系

- **#96(传输失败≠业务 miss)**:要求的不变量已实装(`bookable-facts.ts` error/needs-setup
  不落事实;session 侧八值 verdict 分型;`classifyTransportFailure` 分型)。建议 owner 核对
  triage 留下的两条流程项(独立 PR 归属、五类反例覆盖)后关闭。本设计不重复立项。
- **#102(typed benchmark tool contracts)**:benchmark 桥正在建的「单一 typed 描述符 →
  模型可见 schema + spawn 前校验」与 §4 机制③ 是同一模式的两端——#102 验证模式,
  产品侧随后采纳(不是等它,两条独立 PR 线)。
- **#100(minimal kernel)**:普通 LLM 性能的度量面(见 §4 末尾)。
- **#82(world2agent 事件驱动)**:未来接缝——外部 sensor event 作为**健康面的新生产者**
  (站点断 → 通道态置 down)与愿望池 conditions 的新触发源,消费既有接缝,不需要新
  运行时。记为兼容方向,不在本期承诺。

## 4. 命题一:如何长久保持工具调用性能(含普通 LLM)

**总论:性能不押注模型聪明,押注「确定性控制面 + 自愈契约」。** 本仓既有立场
(§3.5「能用后端工程解决的绝不交给 LLM」、turn-policy「控制面判定必须是确定性组件」)
在工具调用面上的完整展开为六条机制:

1. **判定归代码,模型只做语义**。路由(turn-policy)、预算、日期闸、verdict 分型、
   通道状态、改道顺位——全部零 LLM。普通模型不需要「理解生态」,只需要读懂当前
   这一次结果里的下一步行指令。
2. **契约在失败现场教学**。每种失败自带恢复指令:needs-setup 带 setup、challenged 带
   「停手」、miss≠error 分开陈述、routing 带顺位表。弱模型的恢复不依赖记忆系统提示,
   因为指令随失败同帧到达——这是对普通 LLM 最重要的一条,且已被验证有效
   (defeb5b 后 429 盲重试消失)。
3. **typed 工具契约产品化**(普通 LLM 的最大单项杠杆)。当前 23 个注册工具的参数面是
   `query: { type: 'json' }` 无类型 blob——模型看不到逐字段 schema,强弱模型差距全部
   暴露在「能不能猜对参数形状」上。dsh `defineTool` 原生支持 typed ParameterSchemaSpec
   (object/properties/enum/const/required/oneOf,`validateArgs` 在 execute 前校验,
   `parameterSchemaSpecToJsonSchema` 投影为模型可见 JSON Schema)——**blob 是本仓的
   选择,不是上游的限制**。把高流量工具(flyai/session/hotel/weather 先行)迁到
   `type:'object'` + 逐字段约束 + `additionalProperties:false`:模型可见结构 → 普通模型
   也能一次成型;宿主权校验 → 畸形参数在 execute 前被结构化拒绝(拒绝形状保持
   ADR-13 ToolFailure,迁移测试锁死);`interpretArgs` 留作旧形态容忍层。
4. **健康面让状态可见**(§2.2):持久面(doctor)管「这台机器上通道行不行」,会话面
   管「这次会话里通道刚才怎么了」——预empt 取代盲重试,可解释取代哑失败。
5. **证据链分级即可靠性声明**。[实时API]/[会话]/[静态包:估算] 逐源标注,产物事实闸
   (ADR-19)强制回溯——可靠性是声明出来的契约,不靠模型自觉,不因模型换代而漂移。
6. **事故→夹具闭环**。每个真实事故当天下沉为回归锚点:迪拜 429 → needs-setup verdict;
   婚礼行程 → turn-policy 词表与 handoff;南宁电报码 → 129 城第一方校准 + 防漂移断言。
   评测三层(ADR-11)中,**benchmark 冻结 treatment(#100/#102,显式钉 deepseek-v4-flash
   这类普通模型)就是「普通 LLM 表现」的度量闸**——工具契约的每次迁移以一轮
   canary 为证据,不达标不合入。

「长久」的定义:以上全部是**结构**(代码 + 数据 + 测试),不是 prompt 散文。散文随模型
换代腐坏;带测试的契约不腐坏——腐坏发生时会红,红了就有人修。

## 5. 命题二:如何维持工具生态开放、最高可扩展性

**现状已有的五条开放接缝**(不重建):效应注册表(加一行 handler + 一行策略表 + 一条
断言,「没有策略表行就没有效应」)、session 适配器(携程/12306 样板)、CLI-spawn 能力
模式(flyai/hbcli/anything 同构:spawn→parse→verdict,永不抛错)、agent-reach 反射桥
(上游加渠道 gotry 零改动——「wrapper 不是 router」)、patch 宿主插件(map/calendar/ask-user)。

**设计把开放度再推一档**:

1. **通道注册表 + 工具描述符单一来源**(§2.1 与 §4③ 是同一件事的两个面):每个工具
   = 一份描述符(name/intents/typed params/verdict 词表/证据模板/quotaClass/healthClass)
   + 一个 handler 绑定;`index.ts` 从 1500 行注册表收缩为装配器。第三方(或未来的
   agent 自己)贡献工具 = 描述符 + handler + 测试,评审面收敛为描述符本身。
2. **persona/描述/doctor 由注册表生成**(§2.1):加一个通道要动的 prose 站点数从
   N(persona + 每工具描述 + doctor + 文档)降为 0——**可扩展性的度量 = 加一个通道
   需要手改的文件数,目标:1 注册表行 + 1 handler + 测试**。
3. **session 适配器契约文档化**:12306 的第一方校准法(官方站表/座位桶映射逐条核对 +
   verify 快照 + 防漂移断言)是已验证模板——写适配器作者指南(探测 → 金标准 fixture →
   双源 shape gate → 漂移锁),社区/后来者加站点不触核心。适配器是生态的扩展单元。
4. **反射桥为默认模式**:新 CLI 族能力默认走发现/反射透传,不写 per-channel switch
   (D-4a' 的 founder 纠偏上升为模式纪律)。
5. **事件面预留**(#82):外部事件进健康面与愿望池 conditions,消费既有接缝。
6. **不开放的面(边界即信任)**:复用矩阵硬约束(代码级复用仅限 open-source import,
   内部资产只 bridge/reference);写工具永远过 WriteGate(M5),可扩展性止于写边界;
   红线随行——任何贡献的工具写动机画像必须带 evidence,入愿望池必须带 conditions。

开放与可信不是 trade-off:注册表/描述符让「加东西」更容易,verdict 词表/证据链/
WriteGate 让「加进来的东西」自动遵守同一套纪律——**生态开放的上限由契约刚度决定,
不由工具数量决定**。

## 6. 落地序列(分层,每层独立 PR)

- **L0(纯文档/数据面,零行为变化)**:✅ 已落地 01e002c/9b7ad07(通道注册表 +
  doctor v2 + calendar setup 状态面);#96 核对关闭待 owner。
- **L1(契约迁移,过全栈回归 + 六状态面同步)**:✅ routing 建议字段 + 会话通道状态 +
  persona (19) 生成卡片(01e002c);余量入 issue:
  #112(typed 参数契约迁移,D-30)/ #113(工具描述首行生成 + doctor 宿主插件覆盖面)。
- **L2(周边收口)**:#114(bootstrap 启动体检摘要)/ #115(解译器迁移收尾,D-23)/
  #116(适配器作者指南 + 携程真会话校准,D-13)/ #117(商店版扩展检测,D-24 残量)/
  #118(事实闸酒店 claim + 渲染原语单向生成,D-26)/ #119(外部事件接缝设计,#82)/
  #120(legacy vendored 处置,D-27)。

> 拍板记录:D-7/D-8/D-9 已于 2026-09-03 按「推进实现落地」采纳落地(issues #106/#107/#108 同日关闭);
> 触发式后置项(D-15/D-18/D-19/D-22/D-29、M5 WriteGate、产品统一 key 池)不在本序列——赎回时机见 architecture §10。

## 7. 决策点汇总(同步进 `decisions-needed.md`)

| # | 议题 | 建议 | 关联 |
|---|---|---|---|
| D-7 | 有额度工具的归属机制 | trial=导流层;正式用 user-key/user-session;产品统一 key 池暂缓至 M3 cohort | #107 |
| D-8 | 编排策略 | 静态平铺 + 健康态驱动的动态建议(本设计);不解译器层自动改道 | #108 |
| D-9 | dsh-calendar 分发 | 默认不挂载(setup 状态面 `~/.gotry/calendar.json`,`npx gotry setup calendar` on/off;**env 不作产品开关**)+ doctor 引导;备选保留挂载 + 引导 | #106 |
