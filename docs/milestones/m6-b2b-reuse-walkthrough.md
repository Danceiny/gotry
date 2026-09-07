# M6 B2B 复用推演纪要(P6,待创始人评审)

> 状态:draft(2026-09-08,issue #137 跟进起草;**P6 exit = 本文通过创始人评审**,评审前 M6 entry gate 不满足)
> 验收口径(总纲 §4 P6 行):选 1-2 个 B2B 形态,推演两层为什么的包裹与 99% 复用边界;红线随行口径。
> 输入:`gotry-master-outline.md` §3.7(契约设计原文)、`research/enterprise-travel-reference-study.md`(装饰器合规收口/领域 skill → M6 采纳项)、代码现状勘察(2026-09-08,基于 main `5f47c7d`)。

---

## 0. 结论先行

1. **B2B 形态选两个**:旅行社嵌入(主,对应 M6 exit 的「试点」形态)+ 目的地文旅(辅,验证 sponsor 配置面不是对着单一场景硬编码)。
2. **复用 seam 已经存在且单点**:`MotivationProfile + hard 约束集`(`ts/src/model.ts:36`)是唯一契约对象,下游(求解/卡片/行程/记忆/异步)全部只消费它;`gotry_motivation_save` 工具描述已把「B2B 复用缝」写进契约面(`ts/src/index.ts:366`)。推演未发现第二处需要 principal/sponsor 感知的内核位置。
3. **「99% 复用」可测口径 = 内核零改动 git 断言 + 复用面行数占比**,见 §4;M6 exit 时按此口径出实测数字,不再引用论断。
4. **机制路径零发明**:booking-surface 的 `dsh-plugin.ts` + `buildDshEmbeddedBookingPatch` 已验证「按路径注册插件、内核零改动」的完整先例;M6 旅行社嵌入照此模板,新增 `sponsor` 插件三件套(入口/库存池/配置),不新增任何内核机制。
5. **Entry gate 现状**:M5 未 exit(交易闭环未开闸),P6 纪要即本文。两条件都满足前不写 M6 实现代码(architecture §9:不得由并行实现倒推开闸)。

## 1. 术语澄清:两个 principal,勿混

| | M6 的 principal(本纪要) | §8.23 的 `BookingIngressPrincipal` |
|---|---|---|
| 语义 | 出行人——动机访谈的到达对象,「为什么出发」的主体 | BFF 认证的 HTTP 身份(subject/scope),ingress 防重放安全边界 |
| 代码 | 无(仅 `motivation_save` 描述与文档预留) | `booking-surface/contracts.ts:377` 等,已实现 |

M6 实现时不得复用 §8.23 的类型/命名承载 M6 语义;sponsor 插件的命名空间用 `sponsor.*` 前缀与 `booking.*` 隔离。

## 2. 两层为什么的包裹推演

**B2C(现状)**:principal = sponsor = 用户本人。动机访谈(素材→憧憬→硬约束→候选集,素材中的目的地只是软偏好)直达 `gotry_motivation_save`,落盘 MotivationProfile,下游全链消费。

**B2B 旅行社嵌入(主形态)**:

- principal = 出行人(游客);sponsor = 旅行社。**动机访谈到达的永远是 principal**——旅行社可以转述「客户为什么要出发」,但 evidence 红线不变:落盘的 weights delta 必须带出行人原话级 evidence(P0 反虚构对 B2B 同样生效,`index.ts:391` 的无 evidence 拒绝落盘不因插件化放松)。
- sponsor 层是**配置与库存的包裹,不是动机的包裹**:旅行社注入的是库存池(打包线路/团期/协议价)、品牌入口、披露规则;它**写不进** MotivationProfile——sponsor 意图(卖利润高的线路)与 principal 动机(为什么出发)在数据层就是两个对象,复用 seam 的单点性保证了这个隔离是构造性的而非约定性的。
- 旅程走查(旅行社版):sponsor 入口(旅行社小程序/H5 嵌入)→ 动机访谈(对出行人)→ `motivation_save`(同 C 端,零改动)→ feasibility/行程/透明卡片(同 C 端,零改动;卡片按 sponsor 配置渲染库存池内的候选)→ **透明卡片披露 sponsor 收益**(红线随行,见 §5)→ 异步规划(同 C 端,零改动)。

**B2B 目的地文旅(辅形态)**:sponsor = 目的地文旅局。差异只在 sponsor 配置面:库存池 = 本地 POI/票务/场景(而非打包线路),入口 = 目的地导流页,披露规则 = 文旅合作素材的来源标注。动机契约、求解、卡片、记忆全链不动。辅形态的存在意义:证明「变化只发生在入口、库存池与 sponsor 配置」这三个插件位是完备枚举,不是对旅行社的特设。

## 3. 复用边界清单(基于 main `5f47c7d` 代码勘察)

**复用面(内核,B2B 下直接消费、零改动)**:

| 内核组件 | 位置 | B2B 消费方式 |
|---|---|---|
| MotivationProfile + hard 约束 | `ts/src/model.ts:36`、`parseMotivation:107` | 原样;B2B 不新增字段(weights 语义是出行人的,不随 sponsor 变) |
| 动机落盘/合并守门 | `memory-capture.ts`(mergeProfile)、`state-ledger.ts:260` | 原样;evidence 红线随行 |
| 求解(feasibility/Z3) | `unified.ts`(anchors/Z3 断言/unsat_core) | 原样;候选集来自 sponsor 库存池,求解逻辑不感知 |
| 透明卡片 | `i18n.ts`、卡片刻度 | 原样 + sponsor 收益披露字段(见 §5,唯一内核**预留**点) |
| 记忆/异步规划/账本 | `memory-*`、async 工单、ledger | 原样;隔离 stateRoot 按租户/sponsor 划分 |
| persona + motivation_brief 变量 | `index.ts:239`、cordis patch persona | 原样;B2B 场景 persona 语气走 sponsor 配置变量,不改契约 22 条 |

**变化面(三个插件位,全部新增、不触碰内核)**:

| 插件位 | 旅行社形态 | 目的地文旅形态 | 机制模板 |
|---|---|---|---|
| 入口 | 旅行社 H5/小程序嵌入 + BFF 绑定(§8.23 seam 复用) | 目的地导流页 | `dsh-plugin.ts` + `buildDshEmbeddedBookingPatch` 先例 |
| 库存池 | 打包线路/团期/协议价(只读工具注册 `ctx.tools.register`) | 本地 POI/票务 | channel-registry 注册表模式 |
| sponsor 配置 | 品牌/佣金披露规则/客服联系 | 素材来源标注规则 | cordis patch `insert` 条目 + config |

参考研究采纳项落位:合规收口走 dsh-llm 桥接面 Model 装饰器(企业行程/报销/身份数据过合规层),领域 skill 体系 = sponsor 配置的落地形态(skill = 工具集+prompt+边界守卫+渲染器)。二者都是 M6 Entry 后的交付物候选,本推演只确认**它们装在三个插件位内,不需要第三种变化面**。

## 4. 「99% 复用」实测口径(M6 exit 数字从这里来)

论断(下游只消费契约)到数字的口径,三件套:

1. **内核零改动 git 断言**:B2B 形态分支上,内核文件集合(上表复用面)与 main 逐字节一致——CI 断言 `git diff main -- <内核文件清单>` 为空。这是「零内核改动」的字面验收。
2. **复用面行数占比**:B2B 运行时实际加载模块中,内核(非 `sponsor.*`)行数 ÷ 总行数。分母含 sponsor 插件三件套,预期sponsor 插件是极薄层(入口胶水+库存工具+配置);数字即「复用率」实测值,写进 M6 exit 证据。
3. **端到端旅程证据**:隔离 stateRoot 跑旅行社嵌入全链(动机访谈→save→feasibility→卡片含 sponsor 披露→异步工单),证明链路里没有任何一步 fallback 到「改内核才走得通」。

M6 exit 表述从「99% 复用」改为上述口径的实测数字(如「内核 diff=0;复用面占比 X%;旅程证据链 N 步」)。

## 5. 红线随行口径

- **sponsor 收益披露(§3.7 红线)**:透明卡片在 B2B 下新增 sponsor 收益/合作来源字段——这是推演发现的**唯一内核预留点**:卡片 schema 需预留披露槽位(v1 时字段可空)。落位方式二选一,评审时定:①内核 schema 预留可空字段(B2C 恒空);②披露槽位本身也是 sponsor 插件注入的渲染片段。倾向 ②(保持内核对 sponsor 零感知),待评审判定。
- **evidence 红线**:`motivation_save` 无 evidence 拒绝落盘,B2B 不放松(§2)。
- **WriteGate 随行**:B2B 的预订/支付写路径同受 M5 WriteGate L0-L4 管辖,sponsor 代理预订不豁免确认。
- ** wishing pool conditions 强制**:愿望池条目 conditions 对 B2B 出行人同样强制。

## 6. 与 M5 的依赖(gate 关系)

M6 Entry = M5 exit + P6 评审。M6 对 M5 交付的真实依赖:WriteGate 生产化(B2B 写路径复用 L2/L3 seam)、佣金披露(红线随行的 C 端先行版)、booking_saga_fsm 边表(B2B 代理预订走同一边表)。**这些依赖意味着 M5 的设计已把 B2B 当客户,但不构成提前实现 M6 的理由**——本纪要全部产出为推演与口径,零实现代码。

## 7. 待创始人评审的开放问题

1. §5 披露槽位落位:内核 schema 预留(①)vs sponsor 插件注入(②)——倾向 ②。
2. B2B 形态二选一确认:目的地文旅是否作为辅形态进入 M6 验收(主形态旅行社不变)。
3. 实测口径 §4 的占比公式是否作为 M6 exit 唯一数字口径(替代「99%」表述),以及 roadmap/README 中「99%」字样的退役时机。
4. 试点签约是商业动作,不在工程 exit 内——M6 exit 表述是否显式拆分为「工程 exit(口径三件套)」与「商业验证(试点签约)」两条。

---

评审通过后:P6 exit 达成,M6 entry gate 仅剩 M5 exit;本纪要转入 frozen,实现开闸按 roadmap M6 行执行。
