"""异步深度规划 demo:「一小时后回来,不失望」(总纲 3.6)。

用确定性的 tick 循环模拟 loopx 控制平面,分钟级跑完「一小时后」:
  quota should-run → todo claim → todo update → refresh-state → quota spend-slot

loopx 概念映射(实装时替换为本模拟的对应物):
  objective  → AsyncGoal(objective 字符串 + 验收清单)
  todos      → todo 队列(claim 语义:一次只做一件)
  gates      → 最终交付里的封闭式选择题(等用户,不猜)
  evidence   → evidence_log(每次校验的完整记录,可复盘)
  quota      → max_ticks + 「无进展不花费」:已验证过的候选跳过且不计数

「不失望四条」的验证方式:demo 最后自检并在输出里逐条打勾。
运行:PYTHONPATH=py .venv/bin/python -m gotry_async.demo --input data/golden_erhai.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from typing import List

from gotry_feasibility import Candidate, TravelRequest, solve_candidate


@dataclass
class Todo:
    title: str
    kind: str  # gather | verify | summarize | gates
    done: bool = False


@dataclass
class AsyncGoal:
    objective: str
    todos: List[Todo] = field(default_factory=list)
    evidence: List[dict] = field(default_factory=list)
    ticks_spent: int = 0

    def claim(self) -> Todo:
        for t in self.todos:
            if not t.done:
                return t
        raise StopIteration("no todo left")


def build_goal(candidate_ids) -> AsyncGoal:
    todos = [Todo("汇集候选目的地", "gather")]
    todos += [Todo(f"校验候选 {cid}", "verify") for cid in candidate_ids]
    todos += [Todo("汇总对比", "summarize"), Todo("提炼待决问题(gates)", "gates")]
    return AsyncGoal(objective="生成已验证的周末湖边方案:全成本核算 + 动机匹配 + 不失望四条", todos=todos)


def run(req: TravelRequest, candidates: List[Candidate], max_ticks: int = 8) -> dict:
    by_id = {c.id: c for c in candidates}
    goal = build_goal(list(by_id))
    verdicts = []

    while goal.ticks_spent < max_ticks:
        # quota should-run:还有未完成 todo 才继续
        if all(t.done for t in goal.todos):
            break
        todo = goal.claim()
        progressed = False

        if todo.kind == "gather":
            goal.evidence.append({"tick": goal.ticks_spent, "todo": todo.title,
                                  "result": f"gathered {len(candidates)} candidates"})
            progressed = True

        elif todo.kind == "verify":
            cid = todo.title.split()[-1]
            # 「验证后才花费」:校验产生 verdict 才消耗 tick
            v = solve_candidate(by_id[cid], req)
            verdicts.append(v)
            goal.evidence.append({
                "tick": goal.ticks_spent, "todo": todo.title,
                "result": "feasible" if v.feasible else f"unsat_core={v.unsat_core}",
                "chosen": v.choice and {
                    "out": v.choice.out_service.id, "transfer": v.choice.out_transfer.mode,
                    "ret": v.choice.ret_service.id,
                },
            })
            progressed = True

        elif todo.kind == "summarize":
            goal.evidence.append({"tick": goal.ticks_spent, "todo": todo.title,
                                  "result": f"{sum(1 for v in verdicts if v.feasible)} feasible of {len(verdicts)}"})
            progressed = True

        elif todo.kind == "gates":
            goal.evidence.append({"tick": goal.ticks_spent, "todo": todo.title, "result": "gates drafted"})
            progressed = True

        todo.done = True
        if progressed:
            goal.ticks_spent += 1  # quota spend-slot
        # 无进展的静默跳过不花费(本 demo 中不出现,规则保留给真实集成)

    return assemble_deliverable(goal, verdicts, req)


def assemble_deliverable(goal: AsyncGoal, verdicts, req: TravelRequest) -> dict:
    feasible = sorted([v for v in verdicts if v.feasible], key=lambda v: -v.imagery_match)
    parked = [v for v in verdicts if not v.feasible]

    gates = []
    if len(feasible) >= 2:
        gates.append({
            "id": "g1", "question": f"选 {feasible[0].name} 还是 {feasible[1].name}?",
            "options": [
                {"label": feasible[0].name, "trade_off": f"意象匹配 {feasible[0].imagery_match:.0%},¥{feasible[0].true_cost.money_cny}"},
                {"label": feasible[1].name, "trade_off": f"更省(¥{feasible[1].true_cost.money_cny}),匹配 {feasible[1].imagery_match:.0%}"},
            ],
        })
    if parked and parked[0].wish_pool:
        wp = parked[0].wish_pool
        gates.append({
            "id": "g2",
            "question": f"把 {parked[0].name} 留给「下一次出发」(需 {wp.conditions.get('days')} 天),这次先去可行的?",
            "options": [{"label": "好,先去可行的"}, {"label": "不,我就要为它攒假期"}],
        })

    deliverable = {
        "objective": goal.objective,
        "ticks_spent": goal.ticks_spent,
        "evidence_log": goal.evidence,
        "verified_plans": [
            {
                "name": v.name,
                "match": v.imagery_match,
                "chosen": {"out": v.choice.out_service.id, "transfer": v.choice.out_transfer.mode,
                           "ret": v.choice.ret_service.id},
                "true_cost": v.true_cost.to_dict(),
            } for v in feasible
        ],
        "wish_pool": [v.wish_pool.conditions | {"name": v.name} for v in parked if v.wish_pool],
        "gates": gates,
    }

    # 「不失望四条」自检(总纲 3.6):交付物必须逐条成立
    checks = {
        "1_承诺时间后必有明确产物": len(feasible) + len(parked) > 0,
        "2_产物通过自检清单": all(v.true_cost is not None for v in feasible),
        "3_待决问题全部是简单选择题": len(gates) > 0 and all(len(g["options"]) >= 2 for g in gates),
        "4_做不到的诚实说(带条件与替代)": bool(parked) == bool(deliverable["wish_pool"]),
    }
    deliverable["no_disappointment_checks"] = checks
    return deliverable


def render(deliverable: dict) -> str:
    lines = ["# 回访交付:一小时后的结果", ""]
    lines.append(f"目标:{deliverable['objective']}")
    lines.append(f"(tick 消耗:{deliverable['ticks_spent']},完整证据在 evidence_log)")
    lines.append("")
    lines.append("## 已验证方案")
    for p in deliverable["verified_plans"]:
        t = p["true_cost"]
        lines.append(f"- **{p['name']}**(匹配 {p['match']:.0%}):{p['chosen']['out']} 出发、{p['chosen']['transfer']} 接驳,"
                     f"{t['wake']} 起床、{t['arrive_stay']} 到住处、精力 {t['energy_arrival_pct']}%、共 ¥{t['money_cny']}")
    if deliverable["wish_pool"]:
        lines.append("")
        lines.append("## 「下一次出发」清单(新增)")
        for w in deliverable["wish_pool"]:
            lines.append(f"- {w['name']}:需 {w.get('days')} 天、约 ¥{w.get('budget_cny')}")
    lines.append("")
    lines.append("## 待你决定(选择题)")
    for g in deliverable["gates"]:
        opts = " / ".join(o["label"] + (f"({o['trade_off']})" if "trade_off" in o else "") for o in g["options"])
        lines.append(f"- {g['question']}  →  {opts}")
    lines.append("")
    lines.append("## 不失望四条自检")
    for k, ok in deliverable["no_disappointment_checks"].items():
        lines.append(f"- {'✅' if ok else '❌'} {k}")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="async deep-planning demo (simulated loopx ticks)")
    parser.add_argument("--input", "-i", default="data/golden_erhai.json")
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args(argv)

    payload = json.load(open(args.input, encoding="utf-8"))
    req = TravelRequest.from_dict(payload["request"])
    candidates = [Candidate.from_dict(c) for c in payload["candidates"]]

    deliverable = run(req, candidates)
    if args.json_out:
        json.dump(deliverable, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(render(deliverable))
    ok = all(deliverable["no_disappointment_checks"].values())
    print("\nASYNC DEMO " + ("OK" if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
