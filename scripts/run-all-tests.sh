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
TICKET=$(cd ts && { ls gotry-state/async/*.json 2>/dev/null || true; } | while read -r f; do b="${f%.json}"; [ -f "$b.deliverable.md" ] || basename "$b"; done | head -1)
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
if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN(TS engine/journey/unified + 重放 + 异步 + smoke + hbcli + incident + weather + opensky + anything + diff;明细见各节)"
