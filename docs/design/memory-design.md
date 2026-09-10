# GoTry 记忆域设计(C 端六层重设计)

> 状态:**active design**(M4 交付「六层框架重设计」的正式设计文档;已落地部分以 ✅ 标注,分期增量见 §4)
> 上游:`gotry-master-outline.md` §3.5(六层参考框架,T 系统设计参考,代码与 schema 均不搬用;T 系统=某企业级差旅 Agent 生产系统,来源脱敏)、`gotry-product-design.md` §7.6(长程状态与记忆)
> 纪律:单一文件承载记忆域;版本历史归 git
> 日期:2026-08-28

## 1. 设计立场(不可让渡)

1. **后端工程为体,LLM 为用**:确定性事实(日期/城市/订单/约束)绝不交给 LLM 记忆;LLM 只负责必须语义理解的部分(动机、复盘)——提取已走契约 (18) 动态吸收路径(evidence=用户原话),守门在代码(mergeProfile/appendEvent)。
2. **可溯源 P0**:任何偏好断言必须可回溯到用户原话或工具结果——画像每条权重伴 evidence,效用事件流 append-only。与 D1 §6.3 证据链同构。
3. **画像只进排序,永不进硬过滤**:rank 通道用记忆调权(未来形态 `semantic × bounded_modifier`,RFC S2 已定界),硬过滤只吃用户当轮显式约束——否则记忆会把搜索筛空。
4. **记忆属于用户(红线 6)**:全部落 `gotry-state/` 单目录,可见、可编辑、可删除、可导出;敏感字段(证件/联系方式)永不入库——需要时由后端从登录态填充,fail-closed 澄清。
5. **负面清单**:永不存 ID/token/URL/对话原文;个性化只用画像与聚合行为(产品设计 §7.6 隐私立场)。
6. **多用户 AaaS 前向兼容**(RFC §6.5):单用户期所有记忆即 append-only 事件流 + 稳定主键,未来账本化(CAS/receipt)是存储面替换,语义层零改造。(2026-08-28 存储面已兑现:ADR-15 账本落地,events 唯一权威+投影 fold,守门纯函数原样复用——「语义层零改造」如约成立;多用户 claim/CAS 实装仍按触发器后置 D-15)

## 2. 六层 × 现状映射

| 层 | C 端语义 | 载体 | 状态 |
|---|---|---|---|
| **M1 用户基础** | 常驻城市/时区/工作窗口 | motivation-profile.hard + 会话内声明 | ✅ 工作窗口/时区已入画像;**常驻城市持久化残余 →** [#338](https://github.com/Danceiny/gotry/issues/338)(此残余不回收 §4 已交付的 P1/P2/P3,也不构成 [#20](https://github.com/Danceiny/gotry/issues/20) 的真实准入) |
| **M2 动机与偏好画像** | 动机权重谱系(跨年)、体力档、节奏档、预算档 | motivation-profile.weights/hard + `{{motivation_brief}}` 读回 | ✅ 核心落地(T1:提取归 LLM/守门归代码/读回注入)+ **P3 时间窗衰减已落地(§4)**;**城市场景分级的证据化残余 →** [#339](https://github.com/Danceiny/gotry/issues/339) |
| **M3 预算标准** | 预算档(动机访谈校准 + 历史行为) | budgetTier gate → profile | ✅ gate 校准;**实际成交与规划估算偏差回流残余 →** [#340](https://github.com/Danceiny/gotry/issues/340)(**写入闸由 [#136](https://github.com/Danceiny/gotry/issues/136)/[#231](https://github.com/Danceiny/gotry/issues/231)/[#232](https://github.com/Danceiny/gotry/issues/232)/[#233](https://github.com/Danceiny/gotry/issues/233) 治理,真实交易落地前不实现**) |
| **M4 旅行时间线** | 去过哪/何时/和谁(出发地三级解析的地基) | `gotry-state/trips.jsonl`(§4 P1) | ✅ 已落地 2026-08-28(§4 P1) |
| **M5 同行人档案** | 同行人+约束(高血压/晕车/体力),敏感填充形态 | `gotry-state/companions.json`(§4 P2) | ✅ 已落地 2026-08-28(§4 P2) |
| **M6 会话双区记忆** | Trip Notebook(durable)+ Hot Context(分层过期) | dsh 会话自有 transcript | ❌ **P4(非 P3)**,依赖真实使用模式数据;闸由 [#255](https://github.com/Danceiny/gotry/issues/255) 跟踪,真实使用模式或多用户触发前保持关闭 |

**参考框架之外的 GoTry 增量**(T 系统/ai-agent-book 都没有的,本域原创):

- **效用归因 sidecar**(`memory-utility.ts`,ADR-14):recalled/applied/verified_outcome 三类事件;归因只认 owner 确认——「被召回 ≠ 有用」。这是六层之上的一把**标尺**,量每层记忆值不值得存。
- **触达纪律**(`wish-pool.ts` 0..1):记忆的输出面受「永不主动推销」红线约束(产品红线 96)。

## 3. 已闭合的行为链(2026-08-27/28)

```
写:契约(18) 动态吸收 → motivation_save(mergeProfile 守门:追加不删史/幂等/权重变更伴证据)
读:{{motivation_brief}} persona 注入(空=首访)——回访不重复问已答字段
效用:wish_id + memory-utility.jsonl(归因只认 owner 确认,模型不许自评「有用」)
触达:gotry_wish_pool_list 0..1(新意图先查池);nudge-digest 三通道(可关闭)
度量:memory-metrics 只读投影(回流率基线 verified/recalled)
```

真模型实证:e2e §13(四跳读回逐字一致)/§14(0..1 语义执行)。

## 4. 分期增量(每期独立可验收,无需新依赖)

### P1 旅行时间线(M4 层)——**✅ 已落地 2026-08-28**

`gotry-state/trips.jsonl` append-only:`{ trip_id, destination, start, end, companions?, source, evidence }`。
- **写入源**:①用户口述(「上次去大理是国庆」→ 契约 (18) 同款动态吸收,evidence=原话);②成行确认(wish verified_outcome 落地时自动附 timeline 事件)。两源都过守门纯函数(日期解析复用 slot-spec,冲突即停不猜)。
- **消费**:出发地三级解析(未来行程→时间线→问用户);「去过不再推」进排序通道;回流率分子变准(verified_outcome ⟺ timeline 有对应行程)。
- **验收(已达成)**:断言 100% 可溯源;交叉一致守门(verified 无 timeline = 巡检缺口暴露,不自动补写)。落地 = `travel-timeline.ts` 纯函数 + `gotry_trip_log` 工具 + confirm-outcome 可选自动挂时间线(tripStart 传入才落,否则留缺口)+ `{{motivation_brief}}` 注入「去过」行(最近 3 次)。run-all §20,7/7 断言。

### P2 同行人档案(M5-6 层)——**✅ 已落地 2026-08-28**

`gotry-state/companions.json`:`{ companion_id, label, constraints: { mobility, health, prefs }, evidence }`。
- 写入走动机访谈同款(契约 (18));**健康/无障碍约束只进排序与行程结构建议,不进硬过滤**;渲染时「你上次说晕车」式引用需带 evidence 指针(产品设计故事三的行为面)。
- 验收(已达成):负面清单守卫用例(证件/手机号拒收,4/4 断言 run-all §21);引用可溯源(evidence 数组)。落地 = `companions.ts` 纯函数 + `gotry_companion_save`(第 15 工具)+ `{{motivation_brief}}` 同行人行。

### P3 时间窗衰减(M2 层)——**✅ 已落地 2026-08-28**

行为偏好按 30/90/180/365d 分级窗口衰减(确定性 reducer,置信度只降不删——loopx memory-utility 同款边界);**动机权重永不衰减**(产品设计:目的地会变,动机跨年稳定)。
- 验收(已达成):地板 0.1 旧而不灭/单调/上界 1;动机零衰减为构造性保证(模块无画像 API,5/5 断言 run-all §23)。落地 = `memory-decay.ts` 原语 + memory-metrics 每条 wish「新鲜置信度」列;未来行为偏好层直接复用。

### P4 会话双区记忆(M6 层,后置)

Trip Notebook(durable,后台 LLM 提取,负面清单执行)+ Hot Context(30min 资源/24h 意图分层过期,CAS 防并发)。**依赖真实使用模式数据**,多用户化前不启动。

## 5. 与里程碑/验收的挂钩

- **M4 exit**:「回访规划时长较首访降 ≥50%」← 读回链(e2e §13 已证机制)+ Issue #20/#223 paired-cohort scorer + #228 lifecycle collector(合同、采集路径与 synthetic/candidate 导出已接入,真实 repeat cohort 未到);「经验回流率有基线」← memory-metrics(过程面)+ Issue #20/#228 experience reflux 观测面。P1 落地后回流率分子从「owner 口头确认」升级为「timeline 行程」——基线质变。
- **M5 技术线 T7**:偏好断言 100% 可溯源;「画像不进硬过滤」守卫用例——本设计 §1.2/1.3 即其验收定义。
- **多用户 AaaS**:全部层以 append-only + 稳定主键落地,账本化(RFC §6.5)只换存储面。

## 6. 明确不做

- 对话原文存储(隐私立场);敏感证件/支付字段入库(后端填充);LLM 自由记忆(提取必有守门);为「记忆完整」而提前实现 M5/P4(无真实调用方不花钱)。

## 7. Issue #20 价值证据合同

`ts/scripts/memory-value-report.ts` 只读评分 `memory_value_fixture.v1`:

- **paired cohort**:每个 pair 只接受唯一匿名 subject 的首次与下一次 `eligible + completed` planning flow;returning flow 必须晚于 first flow 完成。active planning duration = wall clock − 预声明且互不重叠的 external waits。分位数固定 nearest-rank,报告 N、首访/回访 p50/p75 与逐 pair reduction p50/p75;阈值比较使用未舍入 raw ratio,只在报告展示时 round。
- **Exit 阈值冻结**:M4 Exit 最小样本数固定为 `minimum_pair_count_for_exit=5`,中位降幅固定为 `target_median_reduction_ratio=0.5`;输入不能降低阈值,非冻结参数由 scorer fail-closed 拒绝。
- **experience reflux**:按 experience_id 统计 recalled 与 verified_outcome 的交集,基线 = verified/recalled;每条事件必须有 evidence_ref。
- **偏好红线**:报告 traceable ratio 与 hard-filter violation count;100% 可溯源且 0 hard filter 才满足验收。
- **P4 闸**:没有 real usage 或 multi-user trigger 时必须保持 `closed`。
- **证据等级**:`synthetic_fixture` 只能证明合同与算法,`exit_evidence_eligible=false`;私有 `observed_private` cohort 也不能靠 `evidence_kind` 自报、HMAC 字符串形状或 evidence_ref 形状直接关闭 Exit。Observed 输入必须逐层 exact schema、全部 subject/flow/pair/experience/assertion/evidence ref 使用 `hmac-sha256:<64lowerhex>` 假名,且携带 `memory_value_source_review.v1` 人工 source-review attestation 合同;该合同必须含 `reviewed_summary_digest_sha256`,并与 scorer 对 `source_review` 之外评分 payload 的 canonical JSON SHA-256 一致,旧 attestation 不能覆盖改过的 summary。缺少或不匹配 attestation 时报告只可作为 candidate,指标可计算但 `exit_ready=false`。#228 collector 导出的 observed_private 仍只给 candidate source_review,绝不生成 reviewer/attestation 字段。真实证据留在 `ts/gotry-state/evidence/m4/` 的 manifest/paired-cohort/summary,不得提交原始用户材料;scorer 只验证 attestation 合同形状与 summary digest 绑定,原始材料核验责任仍归人工 review。
- **兼容迁移**:2026-09-08 起,旧 observed manifest 若缺 `source_review.reviewed_summary_digest_sha256`、使用明文/非 HMAC id、带未声明字段或试图降低阈值,CLI 以 contract-invalid/exit 2 拒绝;私有证据生产者必须重新脱敏、计算本次 summary digest 并补齐 source-review attestation 后再复跑。公开 synthetic fixture 从 N=3 调整为 N=5 指标正例,但 business eligibility 仍恒 false。

复跑夹具:

```bash
cd ts
npx tsx scripts/memory-value-report.ts data/memory-value-fixture.json
npx tsx scripts/memory-lifecycle-tests.ts
```

Collector 用法与持久化不变量见 `memory-lifecycle-collector.md`。
