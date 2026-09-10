[English](evaluation-foundation.md) | [简体中文](evaluation-foundation.zh-CN.md)

# Evaluation Phase 0 基座

> 状态:living 合同(Phase 0)。
> 边界:仅 registry / case / run-receipt / failure-cluster v0 合同加确定性校验器——不安装、不执行任何 benchmark 适配器,无外部 runner,无分数,不做 uplift 声明。
> 上游:[多 benchmark 评测计划 spec](../superpowers/specs/2026-08-30-gotry-multi-benchmark-evaluation-program-design.md)。下游:`scripts/evaluation-contract-tests.ts`。

## 范围

Phase 0 提供 registry、case、run-receipt、failure-cluster v0 合同加确定性校验器。不安装、不执行任何 benchmark 适配器、外部 runner 或官方 evaluator。

版本化的节奏政策覆盖 PR、nightly、weekly 与里程碑规划。纯函数 planner 返回准入判定、`pass^k`、成本/墙钟/工具预算、人工校准要求、failure-registry 路由与 3–5 个优化 PR 的综合归因窗口。它绝不调度或启动适配器、不花任何预算、不产生任何 benchmark 分数。

## 所有权与存储

GoTry git 拥有 TypeScript 合同、七行公开元数据注册表与合成诊断夹具。上游 prompt、回答、gold、轨迹、judge/evaluator 载荷、私有用户材料、凭据与绝对路径一律留在本仓之外。每个 `license.upstream_rights` 的代码/数据/evaluator 判定都携带取值、「已声明/未单独声明」状态与精确验证 URL;`metadata_only_no_upstream_payload` 是 GoTry 更严格的存储政策。

## 准入

每个 benchmark 有独立的官方入口、数据与 evaluator HTTPS 钉扎,含修订类型/取值与信源范围。`not_separately_declared` 是显式未知。每个原生指标把一个稳定回执键映射到其精确上游标签、范围与来源 URL。注册表的 source-fence 类目名只是元数据;可发布的 case/run/failure 值都会被结构化遍历检查非空凭据、绝对路径与原始敏感载荷。

一个 case 固定隔离状态、规范 UTC instant、UTC/IANA 时区、有限预算、禁止写、scorer 修订与四个字面 false 安全标志。仓库内 run 具备 `evidence_kind=synthetic_fixture`、`pairing=null`、`official_result=false`、null 资格回执与 `fixture_only=true`,永远不可计数。failure cluster 把所有 run/case 链接闭合到其精确 benchmark 集合。

## 聚合可计数性

`matched_pair_countable` 只存在于派生输出中。准入要求:恰好两个 `observed_external` 回执构成一对互为 baseline/treatment 的配对;终态 succeeded;同一 provider/model、case、benchmark、protocol、模型参数、scorer、工具、source fence、integrity、evaluator 与原生指标键;baseline/treatment 的 GoTry SHA 不同,且 treatment 唯一变量即 `gotry_sha`;candidate 指纹从规范 `{ treatment_variable: 'gotry_sha', gotry_sha }` 对象重算;硬命中/泄漏命中为零;注册表存在可计数默认值;official-evaluator/source-fence/integrity 证据回执均非空。调用方提供的 `EvaluationEvidenceResolverV0` 必须解析六件公开安全制品(每次 run 三件);每件制品做规范指纹并闭合到 run 身份、绑定 SHA、evaluator 指标、source-fence 输入摘要与 integrity candidate/control 值。case 集、scorer、source-fence 与 evaluator 的指纹从聚合后的 registry/case 对象重算,不信任回执布尔值。

仓库内的 known-good 夹具派生出零配对。聚焦测试构造一个内存中的 `observed_external` 对象,唯一目的是证伪聚合准入逻辑。该对象不写入 git,也不构成 baseline、生产结果、官方分数或 Agent 质量证据。

## 验证与下一阶段

运行 `cd ts && npx tsx scripts/evaluation-contract-tests.ts && npx tsx scripts/evaluation-cadence-tests.ts`,然后 `./scripts/run-all-tests.sh`。安装适配器、执行外部 evaluator、产生结果回执、建立 baseline 或改 Agent,都需要另行批准的后续计划与 PR。基座与适配器工作不构成一轮 Agent 优化,也不在 Discussion #78 里创建新的轮次评论。
