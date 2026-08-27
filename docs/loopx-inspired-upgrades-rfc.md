# RFC:LoopX RFC 群对 GoTry 的映射升级——四道接缝的最小切片

> 状态:**accepted**(2026-08-27 founder 指令:「这些不用我拍板吧,loopx inspired 这些可以直接按建议执行」——四切片按 §7 顺序执行,每片落地时按 §11 同步状态面)
> 修正(同日 founder 指令):GoTry 未来要实现**多用户的 Agent as a Service**——shared-goal-authority-state-provider(claim/CAS/在线权威)不是范围外,是**多用户期的未来正题**,从未采纳清单移入 §6.5 远期采纳面
> 作者:gotry-builder-01(loopx 治理平面)
> 日期:2026-08-27
> 上游权威:`architecture.md`(技术权威面)、`roadmap.md`(M0-M6 时间线)、`gotry-product-design.md`(产品面)
> 下游影响:每项切片在落地时按 §11 同步状态面,并按需登记为 ADR

## 0. 这是什么、不是什么

本文是一次**技术提议(RFC)**:读完 loopx `docs/architecture/rfcs/` 全部 13 篇(1 篇 Accepted、4 篇 Active Research/Product Direction、8 篇 Draft/Integration),提炼其中与 GoTry 现有架构**有真实接缝**的模块设计与技术理念,给出最小可验证切片与执行顺序。

**不是什么**:不是把 loopx 的控制面搬进 GoTry(loopx 在 gotry 里只承担 L5 治理,本文只借鉴**设计模式**,不引入 loopx 运行时依赖);不是提前做 M5/M6 的事(所有切片都落在当前 M3/M4 边界内);不是一次性大重构(每道切片独立、可单独被拍死)。

**读法**:§1 是契合点总表(哪些 RFC 理念与 gotry 哪条线对齐);§2-§5 是四道具体切片(每道:来源 RFC → gotry 现状 → 设计 → 最小切片 → 验收);§6 是明确不采纳的;§7 是执行计划建议。

## 1. 契合点总表:loopx RFC 理念 ↔ GoTry 接缝

loopx RFC 群的六条共性哲学(详见调研底稿,本节省略):观察不升级为权威;typed packet + receipt,prose 不是证据;协议仪式不是进展;先只读投影后执行;bounded context 优先;公开面结构性去敏。

把这六条对到 GoTry 的线,产生四道真实契合点:

| # | loopx RFC 来源 | 核心机制 | GoTry 现状(缺口) | 价值 |
|---|---|---|---|---|
| **S1** | agent-loop-effect-interpreter(Accepted) | canonical packet 四槽(effect_request/interpretation/observation/next_effect)+ handler 是数据 + 五性质 settlement | 12 工具参数契约自由生长,unwrapQuery 是临时防御;execute 返回值无统一 envelope;**已在重演 loopx 已解决的问题** | 高(治理债;拖住每个新工具) |
| **S2** | post-outcome-memory-utility-attribution(Draft) | recall→application→verified_outcome→attribution sidecar;六件语义分离;证据分级;`rank_score=semantic*bounded_modifier` | wish-pool.json 只进不出,无成行验证、无「建议质量」概念;北极星「下一次出发率」无度量底座 | 高(直喂 M4 北极星) |
| **S3** | human-attention-wishlist(Draft) | 注意力三类型 gate/request/wish;wish 非阻塞、不单独唤醒;`piggyback_or_digest`;0..1/turn 防协议仪式 | 「主动回访(可关闭)」仅 roadmap 一行,无机制设计;wish pool 只有入口没有合法的触达形态 | 中(M4 前置;定义了回访的合法边界) |
| **S4** | long-running-agent-reliability(L0–L4 等级) | observer-first 产品入口;L1 non-interference 机器合同;authority 只经显式可回滚 seam | WriteGate 是 M5 二元的「上生产」;booking 写权没有渐进授权路径 | 低(只取哲学,不取机制——M5 拍板时的决策框架) |

**不契合的**:research-exploration(治理平面自用,非产品接缝)、shared-goal-authority(多机协调,GoTry 单用户单机)、typescript-migration(loopx 自身的 Python→TS,GoTry 已去 Python)、benchmark C0-C4(gotry 已有 ADR-11 评测三层,重叠)、agent-im-openviking(IM 协作,无对应场景)。

## 2. S1:工具调用的 canonical packet 纪律(Effect Interpreter 映射)

**来源**:loopx `agent-loop-effect-interpreter-v0`(Accepted)。核心:把每次工具交互建模为 `model → effect_request → harness interprets → observation → model`,handler 是数据不是 callable(跨进程边界必须可序列化),组合需证五性质(identity/associativity/ordered short-circuit/replay/non-commutativity)。

**gotry 现状**:12 个工具的 execute 签名靠约定,参数解析已有三种形态(裸值/包装对象/字符串主键)——`unwrapQuery` 是事后补丁;execute 返回值是自由 JSON,`as never` 已在两处出现(motivation/hotel);guardToolExecute 拦截异常,但**成功路径的返回形状没有任何 envelope**。每个新工具都在重复解决「参数到底长什么样、返回值 LLM 看到什么」。

**设计**(只取纪律,不取 loopx 的 schema 名——避免制造第二个抽象层):

```typescript
// ts/src/tool-packet.ts(新文件,纯类型,零运行时)
interface GotryEffectRequest<TArgs>  { tool: string; args: TArgs }        // 模型→harness
interface GotryObservation<TValue>   { ok: boolean; value?: TValue;       // harness→模型
                                       error?: { kind: string; message: string } }
// unwrapQuery 升格为「interpretation」层:args 三形态归一在这里发生,唯一一处
```

- **最小切片**:① 12 个工具的 execute 统一改返回 `GotryObservation`(guardToolExecute 的异常降级天然就是 `ok:false` 分支,只是把形状显式化);② unwrapQuery 从 index.ts 移到 tool-packet.ts 并改名 `interpretArgs`(语义归位);③ `as never` 两处消除(observation envelope 后类型自洽)。
- **验收**:12 工具的 mock 调用全绿(现有 smoke/replay 不动);tsc 0 错;新增一个 packet 单测(五性质里的 replay+non-commutativity 用既有夹具断言)。
- **成本**:约 60 行 diff,零行为变化(纯形状归一)。
- **拍板点**:是否接受「工具返回值从此有 envelope」这一约束(对新工具是轻微负担,对调用方是确定性)。

## 3. S2:记忆效用归因 sidecar——wish pool 的北极星底座(Post-Outcome Memory 映射)

**来源**:loopx `post-outcome-memory-utility-attribution-v0`。核心:召回 ≠ 使用 ≠ 有用;六件语义(召回/使用/结果/归因/效用状态/生命周期)必须独立记录;证据分级 `owner_correction > controlled_replay > deterministic_effect > evaluator_inference`;归因粒度 `item/set/none`;排序形态 `rank = semantic × bounded_modifier`(效用不能复活语义不相关的)。

**gotry 现状**:`wish-pool.json` 只进不出(契约 6「憧憬入池」+ 工具 `gotry_wish_pool_add`);**没有任何机制知道某条 wish 后来是否成行、建议是否靠谱**;M4 北极星「下一次出发率」目前没有度量底座——只能从聊天记录里人工捞。这正是 loopx RFC 说的「自称用了 ≠ 让结果变好」。

**设计**(纯 sidecar,默认关闭,fail-open,不进主路径):

```jsonl
// gotry-state/memory-utility.jsonl(append-only,与 motivation-profile.json 同级)
{"schema":"memory_utility_observation.v0","wish_id":"w20260827-dali","event":"recalled","ctx":"turn-uuid"}
{"schema":"memory_utility_observation.v0","wish_id":"w20260827-dali","event":"applied","detail":"user accepted 5-day window"}
{"schema":"memory_utility_observation.v0","wish_id":"w20260827-dali","event":"verified_outcome","detail":"booked 2026-10-01"}
// 归因(可选,默认 unknown):evidence_tier 分级,owner_correction 最强
```

- **最小切片**:① `wish-pool.json` 每条加稳定 `wish_id`(现在缺主键);② 新增 `ts/src/memory-utility.ts` 纯函数层:append 三类事件 + 只读投影(每条 wish 的 `utility_status: unknown|helpful|harmful|neutral`);③ 动机访谈工具在召回 wish 时 append `recalled` 事件(只此一处写入,其他全靠 founder/用户后续对话中显式确认才 append `verified_outcome`——**绝不让模型自称「有用」**)。
- **验收**:sidecar 三断言(append 幂等/投影只读/无 verified_outcome 时 utility 永远 unknown);wish-pool 现有测试不破。
- **成本**:约 120 行新文件 + 两处一行接入。
- **拍板点**:是否接受「wish 从此有主键 + 效用事件流」(红线 6 用户数据可见可删——sidecar 与 profile 同级,删除即整文件清,合规)。

## 4. S3:「下一次出发」回访的合法形态(Human Attention Wishlist 映射)

**来源**:loopx `human-attention-wishlist-v0`。核心:人类注意力分三类——`gate`(唯一可阻塞)、`request`(默认非阻塞通知)、`wish`(只顺带呈现,**永远不能单独把 DONT_NOTIFY 改成 NOTIFY**);wish 有稳定 `wish_key` 去重、每 material turn 最多 1 个、active cap;呈现策略 `piggyback_or_digest`;wish 提升的是优先级不是 authority。

**gotry 现状**:roadmap M4 写「主动回访(可关闭)」但无机制设计;产品面第 96 条红线「永不向未询问的用户推销,主动触达只有一种合法形态:『下一次出发』建议(且可关闭)」。**缺的是:回访以什么形态出现、何时合法、如何不沦为打扰**。loopx 的三类型恰好是这道题的答案。

**设计**(只取「注意力类型学」,不取 loopx 的 todo 集成):

```
wish pool 的触达纪律:
- 一次对话最多 surface 1 条「下一次出发」建议(0..1 规则,防协议仪式)
- 只在「条件匹配」时顺带呈现(窗口/预算/季节命中成行条件),绝不单独发起会话
- 用户关闭(契约 6 可关闭)= 该 wish 打 `muted:true`,永不删除(憧憬不被拒绝,但可以休眠)
- 任何「建议你出行」的 push 若存在,必须是 digest 形态且可全局关闭——当前无 push 通道,此条为 M4+ 预留纪律
```

- **最小切片**:① wish-pool.json schema 加 `wish_id` + `muted`(与 S2 共用主键);② `gotry_wish_pool_add` 工具描述与 persona 契约 6 补一句「每轮最多提一条,只在条件命中时」;③ 渲染层若已有 wish 展示,加 0..1 截断。
- **验收**:契约层断言(一轮对话渲染的 wish 建议 ≤1);muted wish 不出现在渲染。
- **成本**:约 30 行 + 契约一句话。
- **拍板点**:0..1/轮 与「绝不单独发起」这两条是否立为硬纪律(产品面红线 96 的技术兑现)。

## 5. S4:WriteGate 的 L0–L4 渐进授权哲学(Reliability 映射,仅哲学)

**来源**:loopx `long-running-agent-reliability-diagnostics-governed-delivery-v0`。核心:L0 native → L1 Shadow Observer(non-interference 是机器合同)→ L2 Advisory(typed recommendation,无执行权)→ L3 Governed Seams(具名 checkpoint 上显式授权)→ L4 Semantic Control Plane;authority 只能经显式、可回滚、预登记的 seam 获得。

**gotry 现状**:WriteGate 是 M5 的「上生产」二元开关。「读操作自由执行,写操作(预订/支付)必须显式确认」——但「显式确认」长什么样、确认后 scope 多大、如何回滚,目前空白。

**设计**(本 RFC 不落代码,只立决策框架):M5 拍板 WriteGate 时,按 L0-L4 分级定义「预订写权」——L2=只给建议+价格,L3=具名 seam(如「单次预订确认」是一等 typed seam,带 receipt),L4=自动续订类。每一级的上线必须可回滚到上一级。

- **最小切片**:无代码。仅在 architecture.md 的 M5 展望段(若 §9 有)或 roadmap M5 交付物描述里,把「WriteGate 生产化」细化为「L0-L4 渐进授权,每级可回滚」一句话。
- **验收**:文档一句话落地,无代码。
- **成本**:零。
- **拍板点**:是否接受把 L0-L4 作为 M5 WriteGate 的默认分级词汇。

## 6. 明确不采纳(及理由)

| loopx RFC | 不采纳理由 |
|---|---|
| research-exploration-control-plane | 治理平面自用(管理 loopx todo/replan),非 GoTry 产品接缝;GoTry 的「研究」就是旅行规划本身,无组合 gap 问题 |
| typescript-control-plane-migration | loopx 自身的 Python→TS 渐进迁移;GoTry 已去 Python(D-7 清偿),无此债 |
| long-horizon-benchmark C0-C4 | GoTry 已有 ADR-11 评测三层(金标准/差分/真模型),主张阶梯重叠 |
| agent-im-openviking / goal-channel | IM 协作场景,GoTry 无外部任务板/群聊通道(多用户 AaaS 期 revisit) |

### 6.5 远期采纳面(多用户 Agent-as-a-Service,2026-08-27 founder 指令立项)

GoTry 未来是多用户的 Agent as a Service——届时 **shared-goal-authority-state-provider** 的三层分离(存储面 provider / 语义权威 authority / 持续协调 supervisor)与 claim/CAS/receipt 协议从「不采纳」转为**未来正题**:

- 多用户 = 多 goal 并发 = 同一行程/同一用户资源的并发写;单机单用户时代的「文件即权威」(wish-pool.json / motivation-profile.json 直接读写)必须升级为 claim-fence-receipt;
- 现有地基与之兼容:S2 的 memory-utility sidecar 是 append-only 事件流,CAS 账本化是存储面替换而非语义改造;
- 触发时机:多用户种子化(共享部署、第二个真实用户)之前完成设计评审;S2/S3 的 wish_id/事件流在单用户期就按「未来可账本化」的形状落(稳定主键 + append-only),避免多用户期返工。

## 7. 执行计划

**顺序**(按「可逆性 × 价值 × 依赖」排序;每道独立,可被单独拍死):

1. **S1 tool-packet**(60 行,零行为变化)——2026-08-27 accepted 当 tick 落地。
2. **S2 memory-utility sidecar**——依赖 S1 的 observation 纪律;直喂 M4 北极星。
3. **S3 wish 触达纪律**——与 S2 共用 wish_id 主键;产品红线 96 的技术兑现,与 S2 同批。
4. **S4 WriteGate L0-L4 词汇**——M5 拍板前任何时刻可落(文档一句话)。

**执行纪律**(原 gate 已由 founder「按建议执行」指令解除):每片落地时按 §11 同步状态面(architecture §9/§10 + roadmap 当前位置),S1/S2 落地各登记一条 ADR;多用户 AaaS 方向只在 §6.5 记录,不提前实现。

**红线**:本 RFC 不引入任何新依赖、不动 hotel-be、不改求解器语义(不在 §10 债务清单内的事不做);所有 sidecar 文件落 `gotry-state/`(红线 6:用户数据可见、可编辑、可删除)。
