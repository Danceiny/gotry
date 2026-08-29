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
echo "=== 5. 异步深度规划:种工单 → 另一进程回收(跨进程闭环,编码 AGENTS.md 清扫规则) ==="
(cd ts && npx tsx scripts/replay-async.ts --request-only > /dev/null) || FAIL=1
TICKET=$(cd ts && { ls gotry-state/async/*.json 2>/dev/null || true; } | while read -r f; do b="${f%.json}"; [ -f "$b.deliverable.md" ] || basename "$b"; done | sed -n '1p')  # sed 非 head:head -1 早关管道,pipefail 下未回收工单 ≥2 时 SIGPIPE 整脚本 141
if [ -z "$TICKET" ]; then echo "FAIL: 未种下待回收工单"; FAIL=1; else (cd ts && npx tsx scripts/async-collect.ts "$TICKET" > /dev/null) || FAIL=1; echo "工单 $TICKET 已跨进程回收"; fi

echo
echo "=== 6. 插件 smoke(注册/execute/红线断言) ==="
(cd ts && npx tsx scripts/smoke.ts | tail -2) || FAIL=1

echo
echo "=== 7. hbcli 能力层(hotelbyte-cli 调用 + 降级封装,4 断言) ==="
(cd ts && npx tsx scripts/hbcli-tests.ts) || FAIL=1

echo
echo "=== 8. 进程护栏(D-NEW,incident-log + uncaughtException 写盘 + guardToolExecute 异常隔离,3 断言) ==="
(cd ts && npx tsx scripts/incident-tests.ts) || FAIL=1

echo
echo "=== 9. 天气能力层(Open-Meteo 免费无 key,5 断言:地理/预报/气候/降级/WMO) ==="
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
echo "=== 25. 发布前离线预验证(pack→解 tarball→依赖声明完整→入口文件→import 面静态检查;rc.9 教训的永久闸) ==="
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
(cd ts && GOTRY_NUDGE_ENABLED=false npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" | grep -q "回访已关闭") || FAIL=1
(cd ts && npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 1 --month 7 | grep -q "不硬推") || FAIL=1
(cd ts && GOTRY_NUDGE_CHANNEL=lark npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 6 --month 11 | grep -q "降级") || FAIL=1
rm -rf "$NUDGE_FIXTURE"
echo "NUDGE SKELETON TESTS OK(0..1 匹配/muted 排除/可关闭/lark 缺 key 降级)"

echo
echo "=== 25. 会话数据面 P1(ReadGuard 双因子/携程批搜解析/城市码表/节律闸 + live FlyAI 官方通道 + live 会话嗅探;GOTRY_SESSION_LIVE=0 可关 live 会话) ==="
(cd ts && npx tsx scripts/session-tests.ts) || FAIL=1

echo
echo "=== 26. action-cache 自愈层(会话数据面 P2:变量化key/指纹被动失效/miss回写/TTL/LRU/损坏容错,纯函数) ==="
(cd ts && npx tsx scripts/action-cache-tests.ts) || FAIL=1

echo
echo "=== 27. 会话面 P2-2 抽取层(a11y兜底抽取/提交件剔除/美团适配器骨架/金标准20 schema,纯函数) ==="
(cd ts && npx tsx scripts/session-extract-tests.ts) || FAIL=1

echo
echo "=== 28. 事务化状态账本(ADR-15:事务原子性/红线进事务/幂等物理化/fold 重建/rewind/one-shot 迁移/工单崩溃恢复 exactly-once/pending_writes saga) ==="
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
if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN(明细见各节;真 LLM 巡检:replay-real.ts / time-eval-tests.ts --real,ADR-11 层)"
