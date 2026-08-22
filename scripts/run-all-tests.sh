#!/usr/bin/env bash
# 全栈回归入口(D4 评测集 v0 的 CI 形态):任何提交前必须全绿。
# 覆盖:Python 单元 + TS 三套件(engine/journey/unified)+ 对话循环重放(mock)
# + 异步工单跨进程闭环 + 插件 smoke + 双实现差分。真 LLM 巡检(replay-real)见 ADR-11 巡检层。
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh 2>/dev/null || true

FAIL=0

echo "=== 1. Python 单元测试 ==="
PYTHONPATH=py .venv/bin/python -m unittest discover -s py/tests -v 2>&1 | tail -2

echo
echo "=== 2. TS engine(洱海金标准,8 断言) ==="
(cd ts && npx tsx scripts/engine-tests.ts) || FAIL=1

echo
echo "=== 3. TS journey(五段链,5 断言) ==="
(cd ts && npx tsx scripts/journey-tests.ts) || FAIL=1

echo
echo "=== 4. TS unified(统一模型+时区+工作窗口,4 断言) ==="
(cd ts && npx tsx scripts/unified-tests.ts) || FAIL=1

echo
echo "=== 5. 对话循环重放(mock,ADR-8/9/10 行为级回归,带终态断言) ==="
(cd ts && npx tsx scripts/replay.ts | tail -3) || FAIL=1

echo
echo "=== 6. 异步深度规划:种工单 → 另一进程回收(跨进程闭环,编码 AGENTS.md 清扫规则) ==="
(cd ts && npx tsx scripts/replay-async.ts --request-only > /dev/null) || FAIL=1
TICKET=$(cd ts && { ls gotry-state/async/*.json 2>/dev/null || true; } | while read -r f; do b="${f%.json}"; [ -f "$b.deliverable.md" ] || basename "$b"; done | head -1)
if [ -z "$TICKET" ]; then echo "FAIL: 未种下待回收工单"; FAIL=1; else (cd ts && npx tsx scripts/async-collect.ts "$TICKET" > /dev/null) || FAIL=1; echo "工单 $TICKET 已跨进程回收"; fi

echo
echo "=== 7. 插件 smoke(注册/execute/红线断言/桥接) ==="
(cd ts && npx tsx scripts/smoke.ts | tail -2) || FAIL=1

echo
echo "=== 8. hbcli 能力层(hotelbyte-cli 调用 + 降级封装,4 断言) ==="
(cd ts && npx tsx scripts/hbcli-tests.ts) || FAIL=1

echo
echo "=== 9. 进程护栏(D-NEW,incident-log + uncaughtException 写盘 2 断言) ==="
(cd ts && npx tsx scripts/incident-tests.ts) || FAIL=1

echo
echo "=== 10. 双实现差分(洱海,TS vs Python oracle) ==="
(cd ts && npx tsx scripts/diff-test.ts | tail -1) || FAIL=1

echo
if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN(Python 单元 + TS 套件 + 重放 + smoke + 差分;明细见各节)"
