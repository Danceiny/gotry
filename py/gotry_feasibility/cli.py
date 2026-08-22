"""JSON-CLI:stdin(或 --input 文件)读请求,stdout 写判定结果。

这是 TS 侧桥接的唯一入口契约(dsh 插件经子进程调用本 CLI):
  echo '{"request": ..., "candidates": [...]}' | python -m gotry_feasibility.cli
  python -m gotry_feasibility.cli --input data/golden_erhai.json --markdown
"""

from __future__ import annotations

import argparse
import json
import sys

from .model import Candidate, TravelRequest
from .unified import segments_from_candidate, solve_choice_segment


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Gotry feasibility engine (door-to-door true cost + Z3)")
    parser.add_argument("--input", "-i", help="JSON 文件路径;缺省读 stdin")
    parser.add_argument("--markdown", action="store_true", help="额外把 answer_md 打印到 stderr")
    args = parser.parse_args(argv)

    raw = open(args.input, encoding="utf-8").read() if args.input else sys.stdin.read()
    payload = json.loads(raw)

    req = TravelRequest.from_dict(payload["request"])
    candidates = [Candidate.from_dict(c) for c in payload["candidates"]]
    spec = segments_from_candidate(payload["request"], candidates)
    result = solve_choice_segment(spec)

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    if args.markdown and "answer_md" in result:
        print(result["answer_md"], file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
