#!/usr/bin/env bash
# 全栈回归入口(D4 评测集 v0 的 CI 形态):任何提交前必须全绿。
# 覆盖:Python 单元(洱海+multi-leg+统一模型 20 例) + TS 三套件(engine/journey/unified)
# + 双实现差分(洱海用例,TS vs Python CLI 桥)。
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
echo "=== 5. 双实现差分(洱海,TS vs Python oracle) ==="
(cd ts && npx tsx scripts/diff-test.ts | tail -1) || FAIL=1

echo
if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN: Python 20/20 + TS engine 8/8 + journey 5/5 + unified 4/4 + 差分一致"
