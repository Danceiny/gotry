# GoTry Roadmap(唯一时间线)

> 定位:**从今天到愿景的唯一里程碑序列**。已有的三套阶段模型(architecture 的 Stage 0-4、总纲的 Phase 0-3、产品设计的 M1-M3)全部归并映射到本文的 M0-M6,旧模型降级为引用。
> 每个里程碑:进入/退出条件、交付物、gate(谁拍板)、依赖。**当前位置用 ← 标注。**
> 状态细节仍以 `architecture.md` §9-10 为准;本文只管时间与顺序。

---

## 当前位置(2026-08-27)

**`@danceiny/gotry@0.0.1-rc.11` 已发布,npm latest 直指本版**(2026-08-29:已知限制清算第一刀——Z3 WASM race 根治(D-17)/实时票价桥(flyai overlay,静态包转显式降级)/i18n 英文面(工程层)/薄壳遗留删除;run-all 新增 §30-§32 三闸;founder 确认制下 agent 执行(「测试好了就可以发新版本」),registry 回拉实测全过);历史:rc.10 2026-08-28 发布(双形态冻结 ADR-16/会话传输层 puppeteer 定案/依赖面根治 rc.9「装得上跑不起」缺陷,曾为 latest;rc.9 标缺陷退役);rc.8 曾直指 latest(2026-08-28:`npx @danceiny/gotry` 即得;干净安装 headless 实测跑通;`rc` tag 暂留同样可用的 rc.7)。License MIT。**M3 工程面全部就位,剩余 = 真实种子用户(founder 侧邀约)**。

rc 序列总览(细节见 release-notes.md,版本历史归 git):

| RC | 状态 | 范围 |
|---|---|---|
| v0.0.1-rc.1 → rc.3 | 已推(tag) | 去 Python / npm 一键骨架 / headless 实测 / Anything 三仓落地 |
| v0.0.1-rc.4 | 已推 | agent-reach 接入(router 形态,后被 wrapper 化取代)+ License MIT |
| v0.0.1-rc.5 | 已发 npm(不可用,被 rc.6 取代) | 首发打通 2FA/恢复码/隔离发布命令;tarball 缺 runtime(教训) |
| **v0.0.1-rc.6** | **已发 npm,可用** | bin 运行时解析 + dist 预编译(绕 Node 拒 strip node_modules .ts)+ data 入包;干净安装 web 200 实测 |
| **v0.0.1-rc.7** | **已发 npm,当前 rc tag** | .env 读用户当前目录 + 无 key 可执行指引 |
| v0.0.1-rc.9 | 已发 npm(曾为 latest;**含缺陷:better-sqlite3 未入 dependencies,装得上跑不起**——被发布后干净安装验证抓出) | M4 记忆域全链/账本/17 工具/D-6 校准 |
| **v0.0.1-rc.10** | **已发 npm,latest 直指本版**(registry 回拉实测:489 包安装/插件加载/bin 全通) | 双形态冻结 ADR-16 + 会话传输层 puppeteer 定案 + 依赖面根治 |
| **v0.0.1-rc.11** | **已发 npm,latest 直指本版**(registry 回拉实测:干净安装/插件加载/bin 全通) | 已知限制清算:Z3 WASM race 根治(D-17)+ 实时票价桥(flyai overlay)+ i18n 英文面(工程层)+ 薄壳删除;run-all 新增 §30-§32 |
| dev(未发) | 持续 main 直推 | issue 冲刺 14/14 交付(README 一致性/域边界/数据污染根除等),17 套 ALL GREEN |
| 后续 | founder 侧 | 种子用户邀约;rc.5 deprecate/rc tag 指向待下次 2FA 授权点击 |

**M3 已被 founder 判定推进(2026-08-26 指令「现在推进 M4」)**:工程面全通+创始人真实使用中;种子用户扩展与 M4 并行。**当前 = M4 记忆域**(T1 行为链已闭合:动态吸收→读回→效用→触达→度量;六层重设计正式落地 `memory-design.md`,分期增量 P1 旅行时间线→P2 同行人档案→P3 时间窗衰减→P4 双区会话后置)。**2026-08-28 会话数据面并行线(RFC `user-session-data-rfc.md`,loopx goal `gotry-session-data-goal`)**:P0 官方通道尽调(飞猪 FlyAI 无 key 只读,机/火检索官方主链路)+ P1 会话骨架(ReadGuard 物理只读/携程 batchSearch 嗅探/节律闸,登录态=存在前提)+ P2 action-cache 自愈层/美团骨架(a11y 兜底,匿名 403 实测)/金标准 20 查询 + P3 工具面两工具(17 工具,smoke §12)与人格契约 (19) 三级路由——与 M4 记忆域正交推进;待 founder 登录态落盘后收尾(双源跑批/真模型巡检)。**2026-08-28 事务化状态基座落地(ADR-15,RFC `transactional-state-rfc.md` accepted「按你的建议来」)**:「文件即权威」升级为「单文件 SQLite 账本即权威」——events append-only + 投影 fold 重建 + 红线(evidence/conditions)进事务 + confirm-outcome 单事务 + 异步工单 durable 恢复(exactly-once)+ pending_writes saga(WriteGate M5 的 L2/L3 基座,D4 定为 M5 Entry 前置);旧 JSON/JSONL 降级为单向导出视图(红线 6),首写自动迁移+快照;run-all §28(44 断言,含双形态)/§29,多用户账本化(RFC §6.5)触发式后置(D-15)。**同日 ADR-16 双形态架构冻结**:本地+Web 一套账本语义、tenant_id 一等字段(schema v2)、同步=事件复制非状态翻译——防「将来大规模重构」的核心冻结,founder 拍板「要的」。**2026-08-29 已知限制清算第一刀(founder 指令「解决这些 known limitations」)**:Z3 WASM race 根治(`z3-shared.ts` 单一实例+会话级互斥,run-all §1 重试止血退役+§30 并发回归闸),薄壳遗留(`shell/`)物理删除——README Known limitations 中两条就此清偿,余两条同批推进:实时票价桥已接入(flyai overlay+env 闸,run-all §31),i18n 工程面落地(run-all §32:en 零缺键/zh 金标准逐字节),人格与工具卡的校准后补齐挂 M4。**2026-08-29 第二批:OTA 平铺 + 账号授权闸(founder 口径「OTA 这些都是工具,不要区分什么主路径/降级路径;这要用到用户的账号,所以必须跟用户确认」)**:飞猪 `search-hotel` 接入(`gotry_flyai_search` kind=hotel,打码价保真);OTA 工具描述与 persona (19) 去「三级路由/主链路/交叉验证」层级,改平铺工具面(证据链逐源标注不变);账号会话工具授权闸进代码——`tools/pre-execute`→`{kind:'ask'}`→dsh 原生 ApprovalService 审批卡(allowed-once 逐次批准,rejected/无审批通道/headless 无应答一律 fail-closed),插件 config `sessionAccess: ask|off` 随时可关(RFC 支柱④进代码);smoke §12-13 + session-tests §H + run-all 全绿;携程酒店/美团会话适配器仍等登录态 seam(独立 tick,见 data-sources §8)。

**2026-08-27 时间感优化落地**(外部时间评测驱动,ADR-12):时间锚点层 + 槽位抽取 v1 + 25 题评测集进仓,真模型 25/25;细节见 architecture.md §1/§9 与 ADR-12。

(历史)**M2 已退出**(b0cfd97):§7-1 三层组合全链落地——OpenFlights 骨架(168 枢纽对,三值语义,求解消费+用户渲染双层)+ OpenSky 校验桥 + bookedResources 锚点 + hbcli 酒店桥(gotry_hotel_search,实时/静态降级);dsh 运行时端到端(DeepSeek 原生,人格+五工具);一键成品入口 `./gotry` 经全新场景验收(带爸妈云南行:人格问对问题→引擎三候选判决→证据链→三道选择题)。G1 已决(中国出境首发)、S1 已冻结、§7-1 已批——均由创始人「按推荐方案执行」指令结算。**当前 = M3 最小可用产品**:最小 Web 面(D-4)+ 种子用户 50-200 人(发起人即首个用户,`./gotry` 即入口)。

## 里程碑总表(三线并行:技术/产品/商业)

| # | 里程碑 | 技术线 | 产品线 | 商业线 | 状态 |
|---|---|---|---|---|---|
| M0 | 确定性管道 | 引擎双实现+真实数据包+对账框架 | demo 规划书 | — | ✅ |
| M1 | **Agent 形态成立** | LLM 进环(S1-S5) | 对话即界面(gates 选择题) | — | ✅(2026-08-22,`bb880f3`) |
| M2 | 实时数据 | hotelbyte-cli 桥+航班源(免费/开源优先),静态包退役为夹具 | 证据链换血([估算]→[实时API]) | 数据源选型(免费/开源优先) | ✅(2026-08-22,`b0cfd97`) |
| M3 | 最小可用产品 | 最小 Web 面(D-4 偿还) | 透明卡片/动机访谈可体验;种子用户 50-200 人 | **G1 市场锁定必须在此前完成**;种子即洱海+普吉两类场景 | ← **当前** |
| M4 | 记忆与「下一次出发」 | 六层 memory 的 C 端域实现;wish pool 联动回访 | 北极星(下一次出发率)开始度量;对账七题=首批校准 | 订阅形态验证(¥49/年锚) | 未启动 |
| M5 | 交易闭环 | WriteGate 上生产;预订/支付/退改 | 佣金披露上线;红线随行 | 三层收入全开(免费/Plus/佣金) | 未启动 |
| M6 | B2B 包裹 | principal/sponsor 插件化,内核零改动跑通旅行社嵌入 | 两层为什么实证 | 「99% 复用」从论断变实测;B2B 试点 | 未启动 |

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

### M3:最小可用产品(← 当前;产品里程碑与商业 gate 交汇点)
- **Entry**:M2 exit ✅ + **G1 市场锁定** ✅(中国出境首发,创始人「按推荐方案执行」指令结算,`b0cfd97` 同批)。
- **交付**:最小 Web 面(透明卡片+动机访谈+gates 的可体验形态,D-4 清偿);种子用户 50-200 人邀请制。
- **Exit**:种子用户行程定稿率 ≥40%、NPS ≥40、POI 幻觉 <1%(评测三件套全绿)。

### M4:记忆与「下一次出发」
- **Entry**:M3 exit。**交付**:C 端记忆域(六层框架重设计)、主动回访(可关闭)、北极星开始度量;对账七题答案=红眼模型与偏好的首批校准样本。
- **Exit**:回访用户规划时长较首访降 ≥50%;经验回流率有基线。

### M5:交易闭环
- **Entry**:M4 exit + 供应链协议。**交付**:WriteGate 生产化——写权按 L0-L4 渐进授权(L2 建议/L3 具名 seam 确认带 receipt/L4 自动类),每级可回滚(RFC S4);预订/支付/退改;佣金披露(红线随行)。
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
