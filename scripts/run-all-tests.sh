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

echo "=== 0. 全量测试运行时前置(一次 dist 构建 + 本地 tsx 路径;packaged/runtime E2E must not reuse stale generated JS) ==="
TSX_BIN="$PWD/ts/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "FAIL: 本地 tsx 不存在: $TSX_BIN"
  FAIL=1
else
  # Some proof suites spawn tsx directly. Keep the repository-local runner
  # ahead of ambient/npm-managed PATH so those children use the same binary.
  export PATH="$(dirname "$TSX_BIN"):$PATH"
fi
(node scripts/run-all-tests-wiring-tests.mjs) || FAIL=1
(node scripts/check-docs-i18n.mjs) || FAIL=1  # 双语对存在性+结构对等(不一致视为 bug)
(node scripts/check-doc-readability.mjs) || FAIL=1  # 读者入口可读性预算+防追加式 issue/date 台账
(node scripts/build-dist.mjs) || FAIL=1
(node scripts/build-dist-compat-tests.mjs) || FAIL=1

echo
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
echo "=== 3b. Issue #341 ground-transfer bounded public-map seam + 2026-09-11 wider D-39 边界冻结(模式/位置词汇封闭/回退完备性含矛盾路线事实/静态↔动态切换契约/证据标注完整/缓存有界;全离线) ==="
(cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/ground-transfer-tests.ts) || FAIL=1

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
(cd ts && npx tsx scripts/smoke-session-gate-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/smoke.ts | tail -2) || FAIL=1

echo
echo "=== 6b. 产物视图能力与 Host 合同(客户端导出/运行时 block 卡片/路径护栏/版本更新,全离线) ==="
(cd ts && npx tsx scripts/artifact-client-contract-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/artifacts-capability-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/dsh-artifact-e2e.ts) || FAIL=1

echo
echo "=== 6c. 行程 HTML 渲染器与产物生成入口(#442/父 #438:纯渲染器有界契约/日期与枚举反例/计划面与证据面分离;注册工具 gotry_itinerary_render 从隔离事实注册表选 id→独占新建 HTML→落盘字节断言,未知/重复/超量 id 与畸形登记行拒绝、撞车不覆盖、符号链接与路径逃逸拒绝、非法输入零写入;全离线合成夹具) ==="
(cd ts && npx tsx scripts/itinerary-html-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/itinerary-artifact-tests.ts) || FAIL=1

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
echo "=== 7d. hbcli 全流程端到端(仅 GOTRY_HBCLI_LIVE=1 显式启用真实 UAT;默认零 binary/网络/凭证探测) ==="
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" GOTRY_HBCLI_LIVE="${GOTRY_HBCLI_LIVE:-0}" GOTRY_HOTELBYTE_SKILLS_LIVE="${GOTRY_HOTELBYTE_SKILLS_LIVE:-0}" npx tsx scripts/hbcli-e2e-tests.ts) || FAIL=1

echo "=== 7f. hbcli live opt-in 隔离证明(可发现 fixture + blocked network:默认 binary=0/network=0/credential=0) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hbcli-live-optin-tests.ts) || FAIL=1

echo
echo "=== 7e. hbcli release-contract(staicli@0.0.3 actual tarball bytes + packaged help/parser; test-only, no supplier request) ==="
if [ -n "${STAICLI_TARBALL:-}" ]; then
  (cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hbcli-release-contract-tests.ts "$STAICLI_TARBALL") || FAIL=1
else
  echo "SKIP: STAICLI_TARBALL not set; targeted artifact proof requires a local staicli-0.0.3.tgz path"
fi

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
echo "=== 15b. doctor 可选依赖体检(注入式三态分级/LLM key 让渡/报告渲染/gotry_doctor 工具面落盘,6 段) ==="
(cd ts && npx tsx scripts/doctor-tests.ts) || FAIL=1

echo
echo "=== 16. 双路径稳定性(纯 TS,unified vs unified 同 spec) ==="
(cd ts && npx tsx scripts/diff-test.ts | tail -1) || FAIL=1

echo
echo "=== 17. hotelbyte-skills 契约对齐(本地描述离线校验;远端读取仅 GOTRY_HOTELBYTE_SKILLS_LIVE=1) ==="
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" GOTRY_HBCLI_LIVE="${GOTRY_HBCLI_LIVE:-0}" GOTRY_HOTELBYTE_SKILLS_LIVE="${GOTRY_HOTELBYTE_SKILLS_LIVE:-0}" npx tsx scripts/skills-contract-tests.ts) || FAIL=1

echo
echo "=== 18. T1 记忆合并守门(M4,纯函数:追加不删史/P0 权重校验/幂等) ==="
(cd ts && npx tsx scripts/memory-capture-tests.ts) || FAIL=1

echo
echo "=== 18b. Issue #338 持久默认出发地 E2E(fresh stateRoot/真实 system-prompt 读回+exact evidence 绑定/显式优先/幂等/跨租户/显式清除/重建/不压算术;隔离临时 stateRoot 全离线) ==="
(cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/issue-338-home-city-e2e.ts) || FAIL=1

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
(cd ts && npx tsx scripts/dsh-runtime-closure-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/dsh-target-closure-proof.ts) || FAIL=1

echo
echo "=== 23a. Issue #289 DSH model-request retry contracts + native loopback request proof ==="
(cd ts && npx tsx scripts/issue-289-model-retry-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/issue-289-model-retry-real-tests.ts) || FAIL=1

echo
echo "=== 23c. Session V3 确定性迁移证明(#268:隔离临时目录文件字节——V2 编解码器编码→JSONL 写盘→catalog 读盘分类 migration-required→V3 恢复→独立 V3 继任者写盘→validation:current 完全解码→迁移后源文件字节比较不变) ==="
(cd ts && npx tsx scripts/dsh-session-v3-migration-proof.ts) || FAIL=1

echo
echo "=== 23d. dsh-subprocess-local 确定性证明(#268:仅公共 API 挂载 Cordis/provider+真实活跃父进程 spawn 非分离子进程+收集 stdout 观察 CHILD_PID+公共 terminate/waitForExit+进程组信号终止整组→子进程 PID 消失+真实 spawnTerminal 每平台输出 'pty-line' 与 exitCode=0;Darwin 预构建下额外断言 node-pty spawn-helper 0755 模式;非 Darwin 平台 helper 不适用,仅报告 platform-pty 事实而不伪造 stat 不存在的 helper;平台中立,不调用私有方法,不传整个环境变量) ==="
(cd ts && npx tsx scripts/dsh-subprocess-local-proof.ts) || FAIL=1
echo "=== 23f. issue #271 dsh child liveness(真实安装 dsh 五个既有 seam + 实际 bin/gotry-inner.js package-shaped inherited-pipe/nonzero/zero/TERM-resistant + benchmark stdout success 与 inherited-pipe/TERM-resistant proof;Node24 外部有界/fresh root/child group descendants/marker/stderr/产品 incident evidence) ==="
(cd ts && npx tsx scripts/issue-271-liveness-tests.ts) || FAIL=1

echo
echo "=== 23e. dsh-http-proxy 本地 SSE + 中毒代理反例(#268:真实 fetch 回环 SSE=200+中毒命中=0+proxyRouteFor 回环直接/非回环代理+proxyEnvironmentForChild NODE_USE_ENV_PROXY/NO_PROXY+finally await disposer+await 两服务器关闭+全局路由恢复直接) ==="
(cd ts && npx tsx scripts/dsh-http-proxy-sse-proof.ts) || FAIL=1

echo
echo "=== 23f. Issue #194 continuable subagent durable id 与 jobs id 边界(真实 dsh ToolRuntime 调用链+可恢复 pre-execute guard+direct-child ownership) ==="
(cd ts && npx tsx scripts/issue-194-job-id-guard-tests.ts) || FAIL=1

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
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" npx tsx scripts/session-tests.ts) || FAIL=1

echo
echo "=== 25b. #279 机票 malformed 隔离扩展 fixture(纯离线,no-spend) ==="
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" npx tsx scripts/flight-malformed-tests.ts) || FAIL=1

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
echo "=== 29b. 账本 tenant 修复计划(#254:只读 inventory/dry-run before-after/无证据零搬移/跨租户同 idem_key 同 wish_id 拒绝/重复 dry-run 幂等/正本零写) ==="
(cd ts && npx tsx scripts/ledger-repair-plan-tests.ts | tail -1) || FAIL=1

echo
echo "=== 29c. 账本 tenant 修复 apply(#254:授权门零写/CAS搬移/目标tenant可见不串读/幂等/注入失败回滚/backup rollback/隔离stateRoot) ==="
(cd ts && npx tsx scripts/ledger-repair-apply-tests.ts | tail -1) || FAIL=1

echo
echo "=== 30. Z3 WASM race 回归(engine/journey/unified 三形态同轮并发压测;修复验证面,run-all §1 止血移除的闸) ==="
(cd ts && npx tsx scripts/z3-race-tests.ts) || FAIL=1

echo
echo "=== 30b. Z3 生命周期局部守门(#227:冷初始化单 Context/低层 cleanup 队列/actual-native barrier/活对象保留/排队合同) ==="
(cd ts && npx tsx scripts/z3-lifecycle-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/z3-lifecycle-fault-tests.ts) || FAIL=1

echo
echo "=== 30c. Z3 race 独立进程重复(#227:多进程重复保存原始 stdout/stderr) ==="
(cd ts && npx tsx scripts/z3-race-repeat-tests.ts) || FAIL=1

echo
echo "=== 30d. 酒店日期输入闸(#283:founder 截图实证 gotry_hotel_search 空/缺/单侧/无法解析/倒序/同日日期仍发起 hbcli 按当前窗口价返回;闸失败 → input_required 不调 hbcli 不写 bridge-latency;通过 → 真实 apply→execute→临时 fixture hbcli 收到精确 argv;隔离 stateRoot + 临时 fixture hbcli,finally 中清理,无 HotelByte/凭证/共享用户数据写入;闸终消费层严格校验拦截 +N 算术溢出(NaN-NaN-NaN)与 JS 自动进位跨千年(10000-01-01)归 unresolved,不调 hbcli;断言数见脚本尾部自报) ==="
(cd ts && npx tsx scripts/hotel-date-gate-tests.ts) || FAIL=1

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
echo "=== 34. M4 memory value paired-cohort 合同(fixture:strict schema/source-review/active planning/reflux/溯源/P4 闸) ==="
(cd ts && npx tsx scripts/memory-value-tests.ts) || FAIL=1

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
echo "=== 39. 可下单事实模型+产物事实闸(issue #46:gotry_bookable_fact.v1 hit/miss 落账/负事实 fail-closed/航司→机场映射 FD=DMK·VZ=BKK/联程仅 protected_connection/时刻矛盾/夜数·O&D·预算不变式/issues #301/#302 finite hotel/policy read-side claim coverage/locked golden 2027 E2E,纯离线) ==="
(cd ts && npx tsx scripts/fact-gate-tests.ts | tail -1) || FAIL=1

echo
echo "=== 41. LLM 价格漂移监测(issue #49 长效机制:offline baseline 比对/fetch 首次写 fixture/up·down·new·removed 四向/坏 baseline SKIP/PR 段落含纪律注脚;零网络,纯离线合同) ==="
(cd ts && npx tsx scripts/price-drift-tests.ts | tail -1) || FAIL=1

echo
echo "=== 42. CHANGELOG 生成器(2026-08-30 owner 拍板补 changelog 机制:Conventional Commits → Keep a Changelog 1.1.0/类型映射/节结构/PR&sha 后缀/prepend 不覆盖历史/空列表/breaking change marker;纯函数) ==="
(cd ts && npx tsx scripts/changelog-tests.ts | tail -1) || FAIL=1

echo
echo "=== 43. 扩展分发通道(ADR-21 分发 A:GitHub Releases 下载链——稳定资产名/URL 合同 + package-extension.mjs 防漂移 / dist-manifest fail-closed / 版本比较 / 回环 e2e installed·up-to-date·check-only·坏SHA·无网·key漂移 / CLI 单行 JSON 契约;全离线) ==="
(cd ts && npx tsx scripts/extension-distribution-tests.ts | tail -1) || FAIL=1

echo
echo "=== 44. sf-live static golden(issue #67:CLI vendor 闭集/OpenFlights 固定修订 provenance/8 条路由覆盖/手工时刻价格带/失败明示回退/跨 provider 软评分;全离线) ==="
(cd ts && npx tsx scripts/static-golden-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/sf-soft-score-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/sf-live-cli-tests.ts) || FAIL=1

echo
echo "=== 44b. sf-summary offline evidence selection(issue #335/#272:canonical filename batch/chronology/source provenance/missing-corrupt fail-closed/legacy unknown;temporary evidence roots only) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/sf-summary-tests.ts) || FAIL=1

echo
echo "=== 44c. sf-live challenge stop(issue #411/RFC §3.5:首个 challenged/guard 即截断批次/challenged 语义不被改写/部分批次+attempted·not_attempted 清单/普通八条批次保留/请求计数断言;真实 CLI runner+确定性 session 模块 overlay,临时根零网络) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 npx tsx scripts/sf-live-challenge-stop-tests.ts) || FAIL=1

package_e2e_bin="${GOTRY_BRIDGE_E2E_BIN:-${GOTRY_BUDGET_E2E_BIN:-}}"
package_e2e_dir=""
package_e2e_install_dir=""
cleanup_packaged_e2e_runtime() {
  if [ -n "$package_e2e_dir" ] && [ -n "$package_e2e_install_dir" ]; then
    rm -rf -- "$package_e2e_dir" "$package_e2e_install_dir"
  elif [ -n "$package_e2e_dir" ]; then
    rm -rf -- "$package_e2e_dir"
  fi
}
trap cleanup_packaged_e2e_runtime EXIT
if [ -n "${GOTRY_BRIDGE_E2E_BIN:-}" ] && [ -n "${GOTRY_BUDGET_E2E_BIN:-}" ] \
  && [ "$GOTRY_BRIDGE_E2E_BIN" != "$GOTRY_BUDGET_E2E_BIN" ]; then
  echo "FAIL: packaged E2E bins disagree"
  FAIL=1
fi
if [ -z "$package_e2e_bin" ]; then
  package_e2e_dir=$(mktemp -d)
  package_e2e_install_dir=$(mktemp -d)
  if npm pack --silent --pack-destination "$package_e2e_dir" >/dev/null; then
    package_e2e_tarballs=("$package_e2e_dir"/*.tgz)
    if [ "${#package_e2e_tarballs[@]}" -eq 1 ] \
      && [ -f "${package_e2e_tarballs[0]}" ] \
      && (cd "$package_e2e_install_dir" && npm init --yes >/dev/null) \
      && npx --yes --package=pnpm@11.5.0 pnpm --dir "$package_e2e_install_dir" add --ignore-scripts "${package_e2e_tarballs[0]}" >/dev/null \
      && npx tsx ts/scripts/pnpm-dsh-closure-proof.ts "$package_e2e_install_dir" \
      && [ -x "$package_e2e_install_dir/node_modules/.bin/gotry" ]; then
      package_e2e_bin="$package_e2e_install_dir/node_modules/.bin/gotry"
    else
      echo "FAIL: packaged E2E runtime preparation failed"
      FAIL=1
    fi
  else
    echo "FAIL: package creation failed"
    FAIL=1
  fi
fi

echo
echo "=== 45. Agent turn boundary(路由 quick/sync/deep→wall-clock 双出口 converge/handoff;handoff 落 gotry_turn_handoff.v1 工单;确定性路由表测 + Cordis integration + dsh headless E2E) ==="
(cd ts && npx tsx scripts/turn-policy-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/agent-planning-turn-deadline-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/turn-handoff-collect-tests.ts) || FAIL=1
if [ -n "$package_e2e_bin" ] && [ -x "$package_e2e_bin" ]; then
  (cd ts && GOTRY_DEADLINE_E2E_BIN="$package_e2e_bin" npx tsx scripts/agent-planning-turn-deadline-e2e.ts) || FAIL=1
else
  echo "FAIL: turn-deadline packaged runtime unavailable"
  FAIL=1
fi

echo
echo "=== 46. Evaluation Phase 0 foundation(four v0 contracts/seven-source registry/diagnostic fixtures/test-only aggregate admission;no adapter,runner,Python,uplift claim) ==="
(cd ts && npx tsx scripts/evaluation-contract-tests.ts) || FAIL=1

echo
echo "=== 47. Evaluation cadence policy(PR/nightly/weekly/milestone admission/pass^k/budgets/calibration/stop signals;no scheduler,runner,spend,score,Agent round) ==="
(cd ts && npx tsx scripts/evaluation-cadence-tests.ts) || FAIL=1

echo
echo "=== 48. Benchmark environment bridge(default-off/allowlist/failure/env isolation/model-driven installed runtime;focused contract + packaged CLI E2E) ==="
(cd ts && npx tsx scripts/benchmark-environment-bridge-tests.ts) || FAIL=1
if [ -n "$package_e2e_bin" ] && [ -x "$package_e2e_bin" ]; then
  (cd ts && GOTRY_BRIDGE_E2E_BIN="$package_e2e_bin" npx tsx scripts/benchmark-environment-bridge-e2e.ts) || FAIL=1
else
  echo "FAIL: benchmark packaged runtime unavailable"
  FAIL=1
fi
echo
echo "=== 49. Booking Copilot embedded contract(canonical schema/npm subpath/closed read registry/task-scoped ledger/real dsh core/BFF-only SSE/production bin;local model fixture) ==="
(node scripts/build-dist.mjs) || FAIL=1
("$TSX_BIN" scripts/booking-surface-package-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-surface-contract-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-gap-code-contract-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-runtime-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-availability-policy-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-availability-ledger-binding-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-receipt-ledger-concurrency-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-operation-ledger-concurrency-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-event-sequence-concurrency-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-server-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-plugin-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-planner-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-startup-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-core-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-bin-proof-tests.ts) || FAIL=1

echo
echo "=== 49b. dsh-map-tools vendored package proof(issue #202:clean tarball install + MIT license/provenance + alpha.3 settings closure + exactly seven map_* tools + network-free inline coordinates) ==="
(GOTRY_MAP_TOOLS_E2E_BIN="$package_e2e_bin" "$TSX_BIN" ts/scripts/map-tools-vendor-package-proof.ts) || FAIL=1
cleanup_packaged_e2e_runtime
trap - EXIT

echo
echo "=== 50. 通道注册表与健康面(docs/design/tool-orchestration-design.md,#106/#107/#108 编排设计:注册表封闭性/意图顺位=证据级×效率/routingAdvice 健康态驱动/flyai 达限即改道·hit 即恢复/verdict 映射闭集/persona 路由卡确定性/JSONL 持久面+坏行容忍/doctor 配额可见+calendar 三态/持久面 down 投影与会话态并集(#436);全离线) ==="
(cd ts && npx tsx scripts/channel-registry-tests.ts) || FAIL=1

echo
echo "=== 51. 指标面板只读聚合面(#138 第一切片:事实闸 verdict 分布与 blocked 率/通道健康 30 天窗/事故面 7 天窗/桥延迟百分位与 >500ms 复审锚点/坏行容忍/空根成型/stateRoot 零写入;全离线) ==="
(cd ts && npx tsx scripts/metrics-report-tests.ts) || FAIL=1

echo
echo "=== 52. 通道探针 tick(外部事件接缝第 1 段:evaluate 纯函数/latest-wins 'ok' 恢复语义/doctor 口径兼容/metrics ok 超越/CLI 探测面/严格时间戳 opt-in(#436:坏行不得顶掉更早有效 down,默认口径不变);全离线) ==="
(cd ts && npx tsx scripts/channel-probe-tests.ts) || FAIL=1

echo
echo "=== 53. 愿望池通道否证(外部事件接缝第 2 段:conditions.channels/down 否证召回/健康不加分/旧调用零破坏/畸形忽略/0..1 集成;全离线) ==="
(cd ts && npx tsx scripts/wish-channel-gate-tests.ts) || FAIL=1

echo
echo "=== 53b. 外部事件 inert W2A 合同(#432/#82:默认关闭/exact tuple admission/核心 envelope 投影/opaque 字段剥离/fetch spy未调用+permission子进程拒绝文件写入/子进程;纯函数无IO,无消费者注册) ==="
(cd ts && npx tsx scripts/external-event-tests.ts) || FAIL=1

echo
echo "=== 54. persona 表层护栏(#192/#2/#194 回归锚:表层规则句存在/13 条契约编号完整(2026-09-11 瘦身改锚)/skill 失败行为指引/动态变量注入面;全离线) ==="
(cd ts && npx tsx scripts/persona-surface-guard-tests.ts) || FAIL=1

echo

echo "=== 55. M4 planning lifecycle collector(issue #228:显式 stateRoot+consent+HMAC key/首返配对/等待边界/reflux+preference/source_review candidate/子进程 scorer 链;全离线) ==="
(cd ts && npx tsx scripts/memory-lifecycle-tests.ts) || FAIL=1

echo "=== 56. tz-resolver + IANA planning offsets(issue #343:China 出境/回程/DST gap/overlap/未知 zone/v1+v2 解析/legacy 兼容/反向日界线/跨日真实 UTC instant;纯离线) ==="
(cd ts && npx tsx scripts/tz-resolver-tests.ts) || FAIL=1

echo "=== 57. issue #343 real-entry adapter precedence(parse→merge→solve→render;dsh fetch fixture + mock shared helper;纯离线) ==="
(cd ts && npx tsx scripts/issue343-real-entry-e2e.ts) || FAIL=1

echo
echo "=== 58. G5 内部差旅桥机械闸(issue #348:tracked 文件零未授权内部桥引用,授权台账 docs/g5-authorization-ledger.md 仅创始人侧维护;含红→绿+exit2 自测,临时 git fixture 走 --root,全离线) ==="
(cd ts && npx tsx scripts/g5-guard.ts) || FAIL=1
(cd ts && npx tsx scripts/g5-guard-tests.ts) || FAIL=1
echo
echo "=== 59. 春节锚点表生成漂移闸(issue #274:lunar-typescript 构建期生成 2026-2099,表/生成块漂移即红;全离线) ==="
(cd ts && npx tsx scripts/gen-lunar-anchors.ts --check) || FAIL=1

echo
echo "=== 60. HotelByte 交易 bridge unknown 查单对账契约(issue #232:book 执行分类 exit0≠成功/种子 fail-closed/窗口内 miss 保 unknown/窗口届满非无订单证明/冲突显式人工/权威负证据才允许新 intent;纯函数契约层,非运行时激活,零真实供应商调用;spawn 级完整链路 E2E 已落地见 §66) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hotelbyte-reconcile-tests.ts) || FAIL=1
echo
echo "=== 61. WriteGate 机制层否证(issue #231:持久化可信审批+原子 outbox;PreparedChallenge/一次性消费/双进程领取竞争/崩溃注入三崩溃点/物理 CHECK+外键+触发器红线/L4 撤回;全离线,零真实供应商调用,非运行时激活,M5 Entry 前产品运行时不实例化) ==="
(cd ts && npx tsx scripts/write-gate-tests.ts) || FAIL=1
echo
echo "=== 62. #233 取消/退款独立结果与佣金披露契约层(M5-4 pre-entry:双对象独立终态无合并成功态/serviceFee≠退款金额/refunded 绑权威证据/披露 digest 入指纹且口径变化即拒/unknown 不默认 none/账本分词与文案分词一致 480 组合;纯契约零真实调用) ==="
(cd ts && npx tsx scripts/issue-233-cancel-refund-commission-tests.ts) || FAIL=1

echo
echo "=== 63. 内核清单冻结+运行模块证据闸(issue #234:gotry_kernel_manifest_v1 哈希零 diff(改核心/删文件/废弃层冒充即红)/真实运行 import trace 全加载(未加载/替换内核即红)/同引擎·账本·闸路径功能覆盖(缺路径即红)/证据快照 manifestHash+evidenceHash 哈希绑定(错 SHA 即红);含反证自测,import-only 零状态写入,全离线) ==="
(cd ts && npx tsx scripts/kernel-manifest-gate.ts) || FAIL=1
(cd ts && npx tsx scripts/kernel-manifest-tests.ts) || FAIL=1

echo
echo "=== 64. sponsor 插件与同内核端到端复用证明(issue #235:三主体分离 fail-closed/激活默认关/越权路由+缺 session 绑定拒绝/同内核零拷贝零重声明/佣金不伪造用户效用/B2B fixture E2E 披露入指纹/B2C 同 runner 零渗入+saga 边逐格同/A-B 同业务 id 不串;全离线 fixture,非运行时激活,零真实调用) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/sponsor-reuse-tests.ts) || FAIL=1
echo
echo "=== 65. Booking Copilot unavailable/changed 恢复链契约(issue #142 非门控切片:检测分类复用 receipt status 闭集/受控恢复三轮计入 planner 三次调用预算/静默换房换航结构性拒绝/降级必携显式披露/审计链 saga 形态可对账;纯函数契约层,非运行时激活,零真实供应商调用) ==="
(cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/booking-recovery-chain-tests.ts) || FAIL=1

echo
echo "=== 66. HotelByte 假 CLI spawn 级完整链路 E2E(issue #232 §5:本地 fixture 二进制经真实 child_process spawn 跑通 quote→approval→book→unknown→query-orders 全链/裸调用红基线 6 证伪/timeout→miss→迟到成功与迟到自动取消/exit0 垃圾·无绑定·部分确认不假成功/进程被杀/同 ref 多单冲突显式/窗口届满转人工不重订/探针失败不证明订单不存在;全离线 fixture,零真实 hbcli·网络·凭据,所有 spawn 有界超时) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hotelbyte-spawn-e2e-tests.ts) || FAIL=1

echo
echo "=== 67. issue #436 持久健康面→注册工具 routing 建议 E2E(跨进程 fixture 探针子进程走真实 evaluateProbeResults+recordChannelEvent 写 channel-health.jsonl→真实注册工具 gotry_flyai_search/gotry_session_search 结果 \`routing\` 字段断言:持久 down 排除(本进程该通道会话态为空)/非会话通道同样生效/会话 down 优先于持久 'ok' 恢复/会话 hit 清除后有效持久 ok 恢复/独立根不串根/过期·未来·缺·坏时间戳均不压制且坏行不得在 latest-wins 前顶掉更早有效 down/同根追加可重复;夹具按产品真实操作标签登记并记录实际请求标签防错位;隔离临时 stateRoot+有界子进程,全离线无网络无真实供应商) ==="
(cd ts && npx tsx scripts/issue436-persisted-routing-e2e.ts) || FAIL=1

echo
echo "=== 67b. Issue #443 本地 Lavish Editor 会话适配器(offline:trust/path 白名单/argv 形状/字节与超时上界/状态机/进程组 reap/生命周期规则;GOTRY_LAVISH_LIVE=0 强锁,合成 lavish-axi 包树,零网络零真浏览器,ambient opt-in 也不得安装/调用外部 CLI) ==="
(cd ts && GOTRY_LAVISH_LIVE=0 npx tsx scripts/lavish-local-tests.ts) || FAIL=1

echo
echo "=== 67c. Registered Lavish review tools (issue #443: host authority, serialized lifecycle, terminal races, owned process cleanup; isolated offline fixtures) ==="
(cd ts && GOTRY_LAVISH_LIVE=0 npx tsx scripts/lavish-product-tools-tests.ts) || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN(明细见各节;真 LLM 巡检:replay-real.ts / time-eval-tests.ts --real,ADR-11 层)"
