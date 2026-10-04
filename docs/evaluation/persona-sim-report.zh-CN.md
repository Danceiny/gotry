[English](persona-sim-report.md) | [简体中文](persona-sim-report.zh-CN.md)

# M3 采集面的 LLM 人格模拟

> 定位：`ts/scripts/persona-sim.ts` 的使用约定与证据边界——一个只产出合成数据的 harness，用模拟旅行者驱动真实的 GoTry 会话逻辑，端到端验证 M3 采集面。
> 状态：living 约定；离线 dry run 于 2026-10-04 验证通过，真实 LLM 批次尚未执行。
> 上游：[路线图](../roadmap.zh-CN.md) §3 M3 闸、[评测地基](evaluation-foundation.zh-CN.md)、[issue #22](https://github.com/Danceiny/gotry/issues/22)。
> 下游：`ts/scripts/persona-sim.ts`、`ts/src/m3-cohort.ts`、`scripts/run-all-tests.sh` §75/§76。

## 证据边界

本 harness 产出的一切都是合成的，并且在落盘字节里就标明了这一点。它只能作为三件事的证据：M3 采集面端到端可用；`ts/scripts/product-metrics.ts` 的漏斗算术由真实记录而非手写记录驱动；一次会话能自观测到的系统侧测量（访谈摩擦、求解判定、事实闸 claim 可回溯性）确实可推导。

除此之外它什么都不能证明。人格是一个读卡片的语言模型，不是旅行者。模拟的定稿与模拟的 NPS 测的是卡片，不是交付给人的价值。这里产出的任何记录都不能计入 M3 或 M4 退出，有三条相互独立的机制在兜底：manifest 带 `evidence_kind=synthetic_fixture`，评分器拒绝把它变成 `business_pass=true`；采集存储拒绝让模拟与真实参与者混居同一存储或同一证据根；导出 attestation 让单字段改标可被发现。M3 闸仍然要求一份被纳入的 50–200 人真实种子用户证据集。

## 真实面与模拟面

每次运行里真实的部分：确定性访谈（`ts/src/loop.ts` 的 `interviewNext`）、翻译接缝及其 spec 校验闸、规划窗口闸、统一求解器（`ts/src/unified.ts`，含洱海候选选择路径）、确定性方案渲染，以及由 `ts/src/index.ts` 的 `apply()` 挂载、按人格隔离 `stateRoot`、读该会话自己的可下单事实注册表的真实注册工具 `gotry_fact_gate`。

每次运行里模拟的部分：旅行者。人格的发言、是否定稿、NPS 分数，全部来自人格模型读取 `ts/data/persona-sim/personas.json` 里的人格卡。每张卡都以本仓已有材料为依据——[用户指南](../user-guide.zh-CN.md)的「试一试」提示词，以及[人格对照台](persona-bench/README.zh-CN.md)的冻结提示词与标准答案——所以一张卡记录的是本仓已经声称能处理的场景，而不是为了好过而编出来的场景。

卡组共七张，覆盖：必须被告知「不可行」的硬约束无解、两周 workation 多段链、带爸妈的慢节奏、必须在周一上班前落地的红眼、预算紧的学生、从未拿到方案的模糊愿望漂流者，以及单独抵达、只用单词回话的同行者。

## 方法：为什么选这个接缝

Harness 在进程内驱动产品，用的正是 `ts/scripts/nightly-evidence.ts` 已经在用于 M3 nightly 证据的同一个接缝：`createOpenAICompatLlm` 作为 `LlmPort`、`newState`/`runTurn` 作为多轮会话、`solveUnified` 挂在 `realtimeSolvePort` 后面。产品自己的工具按 `ts/scripts/smoke.ts` 的方式用 `apply()` 挂到隔离 `stateRoot` 上，所以 claim 审计走的是真实注册工具，而不是对它的再实现。

另一条路是像 `scripts/booking-surface-package-proof.ts` 那样，用 `@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness` 启动真实插件 profile。那条路会额外跑到 dsh 运行时自己的工具派发与模型的工具选择行为，这是本 harness 没有覆盖的。本切片拒绝它的理由是：每次会话要付一次运行时启动（package proof 为此钉了数秒级 initialize 预算外加一整条拆解阶梯）、要打包安装才忠实、并且会把 M3 采集面压在一个现有 M3 证据生产器并不使用的依赖上。选 nightly 接缝让采集面与 nightly 证据面跑在同一份代码上，一边漂移另一边就会暴露。这个缺口是明说而非藏起来的：产品模型的工具选择在这里没有被测量。

## 怎么跑

离线 dry run 不需要凭证、不需要网络、不需要状态：一个本地 OpenAI 兼容 fixture 端点同时为两个模型提供剧本回复，整条流水线——会话、交付方案、定稿决策、NPS、claim 锁定、cohort 记录、评分器——确定性地跑完。

```bash
cd ts && npx tsx scripts/persona-sim.ts --dry-run                      # human-readable
cd ts && npx tsx scripts/persona-sim.ts --dry-run --format json        # machine-readable
cd ts && npx tsx scripts/persona-sim.ts --dry-run --persona erhai-weekend-unwind
```

真实批次是另一回事，需要显式授权。它会花钱，所以挂了预算闸、对未封存价目的模型 fail-closed、对缺 usage 的 provider（成本不可证）也 fail-closed。没有 `LLM_API_KEY` 时它以 `waiting_external_evidence` 状态退出 0，不写任何文件、不花一分钱——与 `ts/scripts/nightly-evidence.ts` 同一条停机纪律。HMAC key 托管在本仓之外，并且永不打印。

```bash
cd ts && \
  LLM_API_KEY="$YOUR_KEY" \
  LLM_BASE_URL="$YOUR_BASE_URL" \
  LLM_MODEL=MiniMax-M2 \
  GOTRY_PERSONA_MODEL=MiniMax-M2 \
  GOTRY_PERSONA_BUDGET_USD=0.25 \
  GOTRY_M3_COHORT_HMAC_KEY="$YOUR_32_PLUS_CHAR_KEY" \
  npx tsx scripts/persona-sim.ts \
    --consent 'operator reviewed issue #22 synthetic persona scope' \
    --evidence-root "$HOME/gotry-evidence/persona-sim-$(date +%Y%m%d)" \
    --state-root "$HOME/gotry-evidence/persona-sim-$(date +%Y%m%d)-capture" \
    --concurrency 2 --format json
```

退出码：批次跑完或等待态为 0，fail-closed 拒绝为 1，预算闸提前停批为 3。证据根会收到 `manifest.json`、`cohort.jsonl`、`provenance.jsonl` 与 `export-attestation.json`；`npx tsx scripts/m3-cohort.ts verify --evidence-root <dir>` 重算全部 digest，`npx tsx scripts/product-metrics.ts --evidence-root <dir> --format json` 给它评分。两者都会说 `synthetic_fixture`，评分器会说 `business_pass: false`。

## dry run 输出样例

以下为 2026-10-04 执行 `npx tsx scripts/persona-sim.ts --dry-run` 的原样输出，仅省略了临时证据路径。那行 stderr 是真实输出的一部分，在限制一节讨论。

```text
[gotry] solveUnified failed (likely wasm thread race): Assertion failed
# persona-sim (dry_run_complete) — SYNTHETIC ONLY, never M3/M4 evidence

- models: product=MiniMax-M2 persona=MiniMax-M2 real_llm=false
- cost: computed $0.028674 / budget $0.25 (real spend $0)
- evidence root: <temp>/evidence

| persona | turns | delivered | finalized | nps | solver | claims | invalid | gate | error |
|---|---|---|---|---|---|---|---|---|---|
| erhai-weekend-unwind | 1 | true | false | 6 | candidate_choice | 2 | 0 | blocked | - |
| krabi-dive-buddy-terse | 3 | true | true | 7 | feasible | 7 | 0 | blocked | - |
| phuket-with-parents | 3 | true | true | 8 | feasible | 6 | 0 | blocked | - |
| phuket-workation-multileg | 3 | true | true | 9 | feasible | 7 | 0 | blocked | - |
| redeye-dubai-monday | 2 | true | true | 9 | feasible | 7 | 0 | blocked | - |
| vague-wish-drifter | 3 | false | false | - | none | - | - | - | - |
| yunnan-budget-student | 1 | true | false | 4 | infeasible(wasm_runtime_error) | 0 | 0 | pass | - |

- scorer: participants=6 finalization=0.666667 nps=0 poi=0
- business_pass: false — evidence_kind=synthetic_fixture cannot prove business pass
```

这张表要按采集面结果读，不是按产品结果读。七个人格里六个拿到了交付方案，四个定稿，漂流者停在访谈阶段因此完全没有产生 cohort 记录——真实漏斗本来就该这么记。计算出的成本是把封存价表应用到 fixture 上报的 token 用量上；真实花费为零。

## claim 审计是怎么推导的

每条 cohort 记录里的 `locked_claims` 与 `invalid_claims` 来自真实注册工具 `gotry_fact_gate`，对交付方案 markdown、按该会话自己隔离 `stateRoot` 里的事实注册表运行。`locked_claims` 就是闸的 `claims_checked`：闸从产物里抽出的每一条可下单 claim。`invalid_claims` 只计注册表与产物直接矛盾的违例——`not_in_source`、`contradicted`、`airport_mapping_conflict`、`price_contradicted`、`fact_anchor_unknown`、`unconditional_check`、`self_transfer_called_through`，以及行程不变量那几类。逐类明细、traceable 计数与闸判定按人格逐条上报。

它不是什么：不是 POI 幻觉率。未核验的 claim 不等于幻觉；模拟运行里没有任何 exact-date 检索工具跑过，所以注册表是空的、每条 claim 都是 `route_unqueried`——闸判定是 `blocked`、`traceable=0`，而 `invalid_claims` 保持 0。上面那个 `poi=0` 的诚实读法是「没有任何 claim 被已记录的事实反驳」，不是「方案准确」。M3 指标的本意——被审计的无效 POI claim 除以锁定的被审计 claim——需要人工审计者拿 claim 比对标准答案。本 harness 产不出那个数字，也不假装能产；它真正建立的是：这个字段由一次真实测量填上，而不是手写上去的。

## 限制

人格模型决定定稿与 NPS，所以两者都是卡组的性质。改一张卡就改了漏斗；每条记录随附的 provenance digest 是该人格系统提示词原文的 SHA-256，所以改过的卡会在证据里显形，而不是无声无息。

人格契约被破坏的会话（JSON 不合法、给从未见过的方案打分、交付前就定稿）被记为错误，不产生 cohort 记录。这是 fail-closed，但它会让漏斗产生偏差，所以逐人格错误清单是输出的一部分，必须与数字一起读。

dry run 不覆盖槽位与 spec 的日期一致性闸：fixture 不返回槽位抽取，于是该闸走它文档化的「无槽位则不参与」分支。真实 LLM 批次会覆盖它。

`data/yunnan-pack.json` 会确定性地让 `solveUnified` 以 z3 WASM 断言失败，用户面回复变成「当前约束下不可行——冲突：wasm_runtime_error」。卡组保留这个用例，因为它是模拟暴露出来的真实缺陷：一个内部引擎错误被当作不可行判决呈现给用户，理由位置上放的是机器 token。Harness 记录判定与 `unsat_core`，而不是把它藏掉。

产品模型的工具选择没有被测量，因为 harness 驱动的是会话接缝而不是 dsh 运行时（见方法一节）。`ts/src/dsh-llm.ts` 的 `chat()` 没有请求超时；harness 改为用自己的截止期限约束每个人格会话，这意味着卡住的 provider 会被归因到会话层而不是那次调用。

会话的 POI 探针在本机装了 `hbcli` 时会打到活体后端，而且它自己没有离线开关。Harness 在批次期间清洗 `PATH` 与 `HOME`，让该探针始终走降级路径；测试套件用 fetch spy 断言全程不联 `127.0.0.1` 以外的任何主机。

## 验证

`./scripts/run-all-tests.sh` §75 跑 `ts/scripts/m3-cohort-tests.ts`（采集契约加四条合成标签反证，每条都带红基线），§76 跑 `ts/scripts/persona-sim-tests.ts`（卡组契约、无凭证停机纪律、完整离线流水线、字节确定性、预算与价目闸、轮次有界、PII 哨兵与非本机断言）。两套都是离线确定性的，都不写 `mkdtemp` 根之外的任何位置。
