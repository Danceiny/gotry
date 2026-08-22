#!/usr/bin/env bash
# 洱海金标准用例:端到端运行(引擎 JSON 输出 + 人话回答)
# 用法:./scripts/run-golden-case.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1. 单元测试(金标准用例断言) ==="
PYTHONPATH=py .venv/bin/python -m unittest discover -s py/tests

echo
echo "=== 2. 引擎 JSON 输出(stdout 前 40 行) ==="
PYTHONPATH=py .venv/bin/python -m gotry_feasibility.cli --input data/golden_erhai.json | head -40

echo
echo "=== 3. 人话回答(--markdown) ==="
PYTHONPATH=py .venv/bin/python -m gotry_feasibility.cli --input data/golden_erhai.json --markdown >/dev/null

echo
echo "=== 4. 异步深度规划 demo(不失望四条自检) ==="
PYTHONPATH=py .venv/bin/python -m gotry_async.demo
