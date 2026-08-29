#!/usr/bin/env bash
# 全栈回归入口(D4 评测集 v0 的 CI 形态):任何提交前必须全绿。
# 覆盖:TS 三套件(engine/journey/unified)+ 对话循环重放(mock)
# + 异步工单跨进程闭环 + 插件 smoke + hbcli + 进程护栏 + 双路径稳定性。
# v0.0.1-rc.2 起去 Python oracle——运行此脚本无需 Python 运行时。
# 真 LLM 巡检(replay-real)见 ADR-11 巡检层。
set -euo pipefail
cd "$(dirname "$0")/.."
set +eu; source ~/.nvm/nvm.sh 2>/dev/null || true; set -eu  # nvm.sh 遇 npmrc prefix 冲突在 set -e 下会 exit 整个脚本(日工作具反复回写 prefix);source 期间放宽 -e/-u

FAIL=0

echo "=== 1. TS engine(洱海金标准,8 断言) ==="
# Z3 WASM race 已根治(2026-08-29,z3-shared.ts 单一实例+会话级互斥):不再需要「重试一次」
# 止血;并发形态的回归闸见 §30 z3-race-tests。
(cd ts && npx tsx scripts/engine-tests.ts) || FAIL=1

echo
echo "=== 2. TS journey(五段链,5 断言) ==="
(cd ts && npx tsx scripts/journey-tests.ts) || FAIL=1

echo
echo "=== 3. TS unified(统一模型+时区+工作窗口,4 断言) ==="
(cd ts && npx tsx scripts/unified-tests.ts) || FAIL=1

echo
echo "=== 4. 对话循环重放(mock,ADR-8/9/10 行为级回归,带终态断言) ==="
(cd ts && npx tsx scripts/replay.ts | tail -3) || FAIL=1

echo
echo "=== 5. 异步深度规划:隔离 stateRoot 种工单 → 另一进程回收(跨进程闭环,不触真实产品状态) ==="
REPO_ROOT=$PWD
ASYNC_FIXTURE=$(mktemp -d)
mkdir -p "$ASYNC_FIXTURE/ts" "$ASYNC_FIXTURE/data"
ln -s "$REPO_ROOT/data/flights_2026.json" "$ASYNC_FIXTURE/data/flights_2026.json"
(cd "$ASYNC_FIXTURE/ts" && "$REPO_ROOT/ts/node_modules/.bin/tsx" "$REPO_ROOT/ts/scripts/replay-async.ts" --request-only > /dev/null) || FAIL=1
TICKET=$({ ls "$ASYNC_FIXTURE"/ts/gotry-state/async/*.json 2>/dev/null || true; } | while read -r f; do b="${f%.json}"; [ -f "$b.deliverable.md" ] || basename "$b"; done | sed -n '1p')  # sed 非 head:head -1 早关管道,pipefail 下未回收工单 ≥2 时 SIGPIPE 整脚本 141
if [ -z "$TICKET" ]; then echo "FAIL: 未种下待回收工单"; FAIL=1; else (cd ts && npx tsx scripts/async-collect.ts "$TICKET" "$ASYNC_FIXTURE/ts" > /dev/null) || FAIL=1; echo "工单 $TICKET 已在隔离 stateRoot 跨进程回收"; fi
rm -rf "$ASYNC_FIXTURE"

echo
echo "=== 6. 插件 smoke(注册/execute/红线断言) ==="
(cd ts && npx tsx scripts/smoke.ts | tail -2) || FAIL=1

echo
echo "=== 7. hbcli 能力层(hotelbyte-cli 调用 + 降级封装 + ENOENT 人话化 + 候选路径,7 断言) ==="
(cd ts && npx tsx scripts/hbcli-tests.ts) || FAIL=1

echo
echo "=== 7b. flyai 能力层(离线假 CLI,4 断言:Sentinel 非业务形状→error/空 itemList→miss/命中→hit/exit≠0→error;issue #24) ==="
(cd ts && npx tsx scripts/flyai-tests.ts) || FAIL=1

echo
echo "=== 7c. 外部依赖自举(check-only 探测/跳过开关/postinstall 非致命;真安装属发布前干净安装实测) ==="
(cd ts && npx tsx scripts/bootstrap-tests.ts) || FAIL=1

echo
echo "=== 7d. hbcli 全流程端到端(隔离 STAICLI_HOME+沙箱账号真打 UAT:取票/实时通道/降级诚实/解译策略/工具面全链;无 bin 或无网 SKIP) ==="
(cd ts && npx tsx scripts/hbcli-e2e-tests.ts) || FAIL=1

echo
echo "=== 8. 进程护栏(D-NEW,incident-log + uncaughtException 写盘 + guardToolExecute 异常隔离,3 断言) ==="
(cd ts && npx tsx scripts/incident-tests.ts) || FAIL=1

echo
echo "=== 9. 天气能力层(Open-Meteo 免费无 key,6 断言:地理/预报/气候/降级/WMO/地名别名阶梯;issue #24) ==="
(cd ts && npx tsx scripts/weather-tests.ts) || FAIL=1

echo
echo "=== 10. 航班实时观测(OpenSky 免费匿名,3 断言:observed 三值/降级/超时) ==="
(cd ts && npx tsx scripts/opensky-tests.ts) || FAIL=1

echo
echo "=== 11. Anything 能力层(hbcli search anything 5 断言:hit/miss/error/timeout/empty) ==="
(cd ts && npx tsx scripts/anything-tests.ts) || FAIL=1

echo
echo "=== 12. probePoi 单测(datasources 编排层,6 类覆盖) ==="
(cd ts && npx tsx scripts/probe-poi-tests.ts) || FAIL=1

echo
echo "=== 13. agent-reach web 读取(readUrl 薄壳,3 断言:非法/超时/live 降级容忍) ==="
(cd ts && npx tsx scripts/agent-reach-tests.ts) || FAIL=1

echo
echo "=== 14. agent-reach 深度(yt-dlp/gh 可选工具,4 断言:三值/not-installed/证据链/超时) ==="
(cd ts && npx tsx scripts/agent-reach-deep-tests.ts) || FAIL=1

echo
echo "=== 15. agent-reach wrapper(反射桥 + 真 doctor,7 断言) ==="
(cd ts && npx tsx scripts/agent-reach-wrapper-tests.ts) || FAIL=1

echo
echo "=== 16. 双路径稳定性(纯 TS,unified vs unified 同 spec) ==="
(cd ts && npx tsx scripts/diff-test.ts | tail -1) || FAIL=1

echo
echo "=== 17. hotelbyte-skills 契约对齐(有凭证真校验,离线 SKIP) ==="
(cd ts && npx tsx scripts/skills-contract-tests.ts) || FAIL=1

echo
echo "=== 18. T1 记忆合并守门(M4,纯函数:追加不删史/P0 权重校验/幂等) ==="
(cd ts && npx tsx scripts/memory-capture-tests.ts) || FAIL=1

echo
echo "=== 19. 时间感评测(时间锚点卡 + 槽位过期校验 + 评分器 + mock 回放管道,确定性;真模型巡检走 --real) ==="
(cd ts && npx tsx scripts/time-eval-tests.ts) || FAIL=1

echo
echo "=== 20. 旅行时间线(memory-design P1 守门面:必填/幂等/重叠冲突/交叉一致) ==="
(cd ts && npx tsx scripts/travel-timeline-tests.ts) || FAIL=1

echo
echo "=== 21. 同行人档案(memory-design P2 守门面:负面清单/合并/幂等) ==="
(cd ts && npx tsx scripts/companion-tests.ts) || FAIL=1

echo
echo "=== 22. 记忆效用指标投影(M4 北极星过程面,只读,空态优雅) ==="
(cd ts && npx tsx scripts/memory-metrics.ts) || FAIL=1

echo
echo "=== 23. 时间窗衰减(memory-design P3:分级窗口/单调/地板/上界/动机零衰减) ==="
(cd ts && npx tsx scripts/memory-decay-tests.ts) || FAIL=1

echo
echo "=== 23b. 发布前离线预验证(pack→解 tarball→依赖声明完整→入口文件→import 面静态检查;rc.9 教训的永久闸;原误标 25 与会话面重号,当日修正) ==="
(cd ts && npx tsx scripts/publish-preverify.ts) || FAIL=1

echo
echo "=== 24. 「下一次出发」回访骨架(nudge-digest:匹配/file 通道/可关闭/无命中不硬推/lark 缺 key 降级) ==="
NUDGE_FIXTURE=$(mktemp -d)
mkdir -p "$NUDGE_FIXTURE/gotry-state"
cat > "$NUDGE_FIXTURE/gotry-state/wish-pool.json" <<'EOF'
[{"wish_id":"wA","name":"普吉","conditions":{"days":5,"budget_cny":7000,"best_months":[11,12]},"added_at":"2026-08-01T00:00:00Z"},
 {"wish_id":"wB","name":"千岛湖","conditions":{"days":2,"budget_cny":1000,"best_months":[4,5]},"added_at":"2026-08-02T00:00:00Z"},
 {"wish_id":"wC","name":"洱海(休眠)","muted":true,"conditions":{"days":5,"budget_cny":4950,"best_months":[11]},"added_at":"2026-08-03T00:00:00Z"}]
EOF
(cd ts && GOTRY_NUDGE_CHANNEL=file GOTRY_NUDGE_FILE="$NUDGE_FIXTURE/digest.md" npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 6 --budget 8000 --month 11 >/dev/null) || FAIL=1
grep -q "普吉" "$NUDGE_FIXTURE/digest.md" || { echo "FAIL: file 摘要应含命中的普吉"; FAIL=1; }
grep -q "洱海" "$NUDGE_FIXTURE/digest.md" && { echo "FAIL: muted 洱海不得召回"; FAIL=1; }
NUDGE_DISABLED_OUTPUT=$(cd ts && GOTRY_NUDGE_ENABLED=false npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE") || FAIL=1
grep -q "回访已关闭" <<<"$NUDGE_DISABLED_OUTPUT" || FAIL=1
NUDGE_NO_MATCH_OUTPUT=$(cd ts && npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 1 --month 7) || FAIL=1
grep -q "不硬推" <<<"$NUDGE_NO_MATCH_OUTPUT" || FAIL=1
NUDGE_LARK_OUTPUT=$(cd ts && GOTRY_NUDGE_CHANNEL=lark npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 6 --month 11) || FAIL=1
grep -q "降级" <<<"$NUDGE_LARK_OUTPUT" || FAIL=1
rm -rf "$NUDGE_FIXTURE"
echo "NUDGE SKELETON TESTS OK(0..1 匹配/muted 排除/可关闭/lark 缺 key 降级)"

echo
echo "=== 25. 会话数据面 P1-P2(ReadGuard/携程解析/节律闸 + #21 字段 fixture scorer/双源合同/waiting-attach no-spend + live FlyAI/会话;GOTRY_SESSION_LIVE=0 关闭全部 live 端点) ==="
(cd ts && npx tsx scripts/session-benchmark.ts) || FAIL=1
(cd ts && npx tsx scripts/session-tests.ts) || FAIL=1

echo
echo "=== 26. action-cache 自愈层(会话数据面 P2:变量化key/指纹被动失效/miss回写/TTL/LRU/损坏容错,纯函数) ==="
(cd ts && npx tsx scripts/action-cache-tests.ts) || FAIL=1

echo
echo "=== 27. 会话面 P2-2 抽取层(a11y兜底抽取/提交件剔除/美团适配器骨架/金标准20 schema,纯函数) ==="
(cd ts && npx tsx scripts/session-extract-tests.ts) || FAIL=1

echo
echo "=== 28. 事务化状态账本(ADR-15:事务原子性/红线进事务/幂等物理化/fold 重建/rewind/one-shot 迁移/工单 exactly-once + 4/4/非4/4 机器终态/pending_writes saga) ==="
(cd ts && npx tsx scripts/ledger-tests.ts | tail -1) || FAIL=1

echo
echo "=== 29. 账本 CLI e2e(migrate 快照/stats/log/export 视图单向/forget 物理硬删带审计/pw-* saga 面) ==="
(cd ts && npx tsx scripts/state-cli-tests.ts | tail -1) || FAIL=1

echo
echo "=== 30. Z3 WASM race 回归(engine/journey/unified 三形态同轮并发压测;修复验证面,run-all §1 止血移除的闸) ==="
(cd ts && npx tsx scripts/z3-race-tests.ts) || FAIL=1

echo
echo "=== 31. 实时票价 overlay(flyai 实时桥 + 静态降级三值语义;纯离线注入,hit 覆写/error 降级/日期词表闸/求解集成) ==="
(cd ts && npx tsx scripts/realtime-pricing-tests.ts | tail -1) || FAIL=1

echo
echo "=== 32. i18n 目录(en 零缺键/默认 zh 金标准逐字节/en 切换数据不动/插值回退) ==="
(cd ts && npx tsx scripts/i18n-tests.ts | tail -1) || FAIL=1

echo
echo "=== 33. M3 cohort 指标合同(冻结阈值/脱敏 schema/真实与 fixture 分流) ==="
M3_FIXTURE_OUTPUT=$(cd ts && npx tsx scripts/product-metrics.ts --fixture data/product-metrics-fixture.json --format json) || FAIL=1
M3_FIXTURE_OUTPUT="$M3_FIXTURE_OUTPUT" node --input-type=module <<'NODE' || FAIL=1
import assert from 'node:assert/strict'
const summary = JSON.parse(process.env.M3_FIXTURE_OUTPUT ?? '{}')
assert.equal(summary.schema_version, 'gotry_m3_product_metrics_summary_v1')
assert.equal(summary.sample.participants, 5)
assert.equal(summary.sample.pass, false)
assert.deepEqual(summary.finalization, { numerator: 2, denominator: 5, rate: 0.4, pass: true })
assert.deepEqual(summary.nps, { promoters: 3, passives: 1, detractors: 1, denominator: 5, score: 40, pass: true })
assert.deepEqual(summary.poi_hallucination, { invalid_claims: 1, locked_claims: 200, rate: 0.005, pass: true })
assert.equal(summary.nightly.replayable_real_llm_runs, 1)
assert.equal(summary.nightly.cost_usd, 1.25)
assert.equal(summary.business_pass, false)
assert.match(summary.business_pass_reason, /synthetic_fixture/)
NODE
M3_TEST_ROOT=$(mktemp -d)
node --input-type=module - "$PWD/ts/data/product-metrics-fixture.json" "$M3_TEST_ROOT" <<'NODE' || FAIL=1
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const source = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const root = process.argv[3]
const positive = structuredClone(source)
positive.manifest.evidence_kind = 'real_seed_cohort'
positive.manifest.cohort_id = 'm3-real-contract-fixture'
positive.cohort = Array.from({ length: 50 }, (_, index) => ({
  ...structuredClone(source.cohort[index % 5]),
  participant_key: `hmac-sha256:${(index + 1).toString(16).padStart(64, '0')}`,
  plan_key: `hmac-sha256:${(index + 101).toString(16).padStart(64, '0')}`,
}))
writeFileSync(join(root, 'positive.json'), JSON.stringify(positive))
const pii = structuredClone(source)
pii.cohort[0].raw_email = 'must-not-enter-evidence@example.com'
writeFileSync(join(root, 'pii.json'), JSON.stringify(pii))
const relaxed = structuredClone(source)
relaxed.manifest.metrics.sample_size.minimum = 1
writeFileSync(join(root, 'relaxed.json'), JSON.stringify(relaxed))
const staleNightly = structuredClone(positive)
staleNightly.nightly_runs[0].executed_at = '2025-08-20T00:00:00Z'
writeFileSync(join(root, 'stale-nightly.json'), JSON.stringify(staleNightly))
NODE
M3_REAL_OUTPUT=$(cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/positive.json" --format json) || FAIL=1
M3_REAL_OUTPUT="$M3_REAL_OUTPUT" node --input-type=module <<'NODE' || FAIL=1
import assert from 'node:assert/strict'
const summary = JSON.parse(process.env.M3_REAL_OUTPUT ?? '{}')
assert.equal(summary.evidence_kind, 'real_seed_cohort')
assert.deepEqual(summary.sample, { participants: 50, minimum: 50, maximum: 200, pass: true })
assert.equal(summary.finalization.rate, 0.4)
assert.equal(summary.nps.score, 40)
assert.equal(summary.poi_hallucination.rate, 0.005)
assert.equal(summary.business_pass, true)
NODE
if (cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/pii.json" --format json >/dev/null 2>&1); then
  echo "FAIL: M3 evidence schema must reject undeclared/raw PII fields"
  FAIL=1
fi
if (cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/relaxed.json" --format json >/dev/null 2>&1); then
  echo "FAIL: M3 acceptance thresholds must not be weakened by evidence input"
  FAIL=1
fi
M3_STALE_OUTPUT=$(cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/stale-nightly.json" --format json) || FAIL=1
M3_STALE_OUTPUT="$M3_STALE_OUTPUT" node --input-type=module <<'NODE' || FAIL=1
import assert from 'node:assert/strict'
const summary = JSON.parse(process.env.M3_STALE_OUTPUT ?? '{}')
assert.equal(summary.nightly.replayable_real_llm_runs, 0)
assert.equal(summary.nightly.pass, false)
assert.equal(summary.business_pass, false)
NODE
rm -rf "$M3_TEST_ROOT"
echo "M3 PRODUCT METRICS TESTS OK(fixture fail-closed/50 人正向合同/PII 拒绝/阈值防篡改/nightly 窗口闸)"

echo
echo "=== 34. M4 memory value paired-cohort 合同(fixture:active planning/reflux/溯源/P4 闸) ==="
M4_REPORT=$(mktemp)
(cd ts && npx tsx scripts/memory-value-report.ts data/memory-value-fixture.json > "$M4_REPORT") || FAIL=1
node - "$M4_REPORT" <<'NODE' || FAIL=1
const { readFileSync } = require('node:fs')
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const checks = [
  ['contract_valid', report.contract_valid === true],
  ['paired N', report.cohort.eligible_pair_count === 3],
  ['first p50/p75', report.cohort.first_active_seconds.p50 === 720 && report.cohort.first_active_seconds.p75 === 900],
  ['returning p50/p75', report.cohort.returning_active_seconds.p50 === 360 && report.cohort.returning_active_seconds.p75 === 450],
  ['paired median reduction', report.cohort.paired_reduction_ratio.p50 === 0.5],
  ['reflux baseline', report.experience_reflux.baseline === 0.5],
  ['assertion traceability', report.preference_assertions.traceable_ratio === 1],
  ['no hard filter', report.preference_assertions.hard_filter_violation_count === 0],
  ['P4 remains closed', report.p4.contract_met === true && report.p4.state === 'closed'],
  ['fixture cannot close M4', report.exit_evidence_eligible === false && report.exit_ready === false]
]
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`memory value fixture check failed: ${name}`)
}
console.log(`MEMORY VALUE REPORT TESTS: ${checks.length}/${checks.length} OK(fixture contract; synthetic evidence cannot close M4)`)
NODE
(cd ts && npx tsx -e '
  import { readFileSync } from "node:fs";
  import { scoreMemoryValue } from "./scripts/memory-value-report.ts";
  const fixture = JSON.parse(readFileSync("data/memory-value-fixture.json", "utf8"));
  const undeclaredWait = structuredClone(fixture);
  undeclaredWait.pairs[0].returning.external_waits[0].code = "undeclared_wait";
  if (scoreMemoryValue(undeclaredWait).contract_valid) throw new Error("undeclared external wait must fail the contract");
  const hardFilter = structuredClone(fixture);
  hardFilter.preference_assertions[0].hard_filter = true;
  if (scoreMemoryValue(hardFilter).preference_assertions.contract_met) throw new Error("memory hard filter must fail acceptance");
  const earlyP4 = structuredClone(fixture);
  earlyP4.p4.state = "open";
  if (scoreMemoryValue(earlyP4).p4.contract_met) throw new Error("P4 must remain closed before a real-usage or multi-user trigger");
  const duplicateSubject = structuredClone(fixture);
  duplicateSubject.pairs[1].subject_ref = duplicateSubject.pairs[0].subject_ref;
  if (scoreMemoryValue(duplicateSubject).contract_valid) throw new Error("one subject must contribute at most one paired measurement");
  const reversedReturn = structuredClone(fixture);
  reversedReturn.pairs[0].returning.started_at = "2026-07-31T10:00:00Z";
  reversedReturn.pairs[0].returning.completed_at = "2026-07-31T10:08:00Z";
  reversedReturn.pairs[0].returning.external_waits = [];
  if (scoreMemoryValue(reversedReturn).contract_valid) throw new Error("returning flow must follow the first completed flow");
') || FAIL=1
rm -f "$M4_REPORT"

echo "=== 35. M3 nightly evidence 生产器合同(封存价表保守换算/未知模型与usage缺失 fail-closed/run_key 确定性/无凭证 waiting 零写入/dry-run mock 全链零落盘;真跑花钱不进 CI) ==="
(cd ts && npx tsx scripts/nightly-evidence-tests.ts) || FAIL=1
NIGHTLY_DRY=$(cd ts && npx tsx scripts/nightly-evidence.ts --dry-run --format json) || FAIL=1
echo "$NIGHTLY_DRY" | grep -q '"state":"dry_run"' || { echo "FAIL: nightly dry-run must exercise the pipeline against mock"; FAIL=1; }
if [ -z "${LLM_API_KEY:-}" ] && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  NIGHTLY_WAIT=$(cd ts && npx tsx scripts/nightly-evidence.ts --no-env-file --format json) || FAIL=1
  echo "$NIGHTLY_WAIT" | grep -q '"state":"waiting_external_evidence"' || { echo "FAIL: missing credential must report waiting_external_evidence"; FAIL=1; }
  echo "nightly CLI: dry-run 演练 + 无凭证等待态已验证(执行环境无真实凭证)"
else
  echo "SKIP: 执行环境存在真实 LLM 凭证,CLI 等待态跳过(真凭证不进 CI,fail-closed)"
fi

echo
echo "=== 36. 预订 saga 状态机(booking_saga_fsm.v1,issue #17 采纳:字母表/边表封闭性 + 主路径/吸收态 + 审计链校验 + 与账本 saga 基座物理对账/多租户,纯函数) ==="
(cd ts && npx tsx scripts/booking-saga-tests.ts | tail -1) || FAIL=1

echo
echo "=== 37. 效应解译器(effect_interpreter.v1,issue #16 采纳:注册表封闭性/指数退避链/断路三态+熔断后零执行/Sentinel 不重试/mock 夹具回放/SESSION 永不重试不熔断/真实 handler 静态包降级,纯离线) ==="
(cd ts && npx tsx scripts/effect-tests.ts) || FAIL=1

echo
echo "=== 38. 会话扩展桥(#21 传输层方案 C:manifest 合同与 key→固定 ID 派生/Node↔扩展常量防漂移/origin 白名单/长轮询取活幂等/心跳判定/提交-回包闭环/needs-extension no-spend/waiting_extension 双源合同;全离线,唯一慢例~6s 为 no-spend 语义本身) ==="
(cd ts && npx tsx scripts/extension-tests.ts) || FAIL=1

echo
echo "=== 40. A2A 入口(M2:骨架+SSE——Agent Card/JSON-RPC message-send+stream+tasks-get+cancel/Bearer 鉴权 fail-closed/userToken 透传/任务终态/SSE 帧序与失败面/M3 限流+指标面;纯离线 stub driver,headless 真对话增量接线待 LLM) ==="
(cd ts && npx tsx scripts/a2a-server-tests.ts) || FAIL=1

echo
if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN(明细见各节;真 LLM 巡检:replay-real.ts / time-eval-tests.ts --real,ADR-11 层)"
