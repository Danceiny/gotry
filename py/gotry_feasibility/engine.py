"""可行性引擎:LLM 翻译约束、确定性求解、无解给最小修改建议(D1 §7.5)。
DEPRECATED(D-1 清偿):统一行程模型(unified.py)是唯一求解入口;
本模块保留为兼容层与差分 oracle,新代码不得调用。

分层纪律:
- model.evaluate_choice 拥有全部算术(门到门全成本);
- 本模块只用 Z3 做「选择」:在班次×接驳×返程的组合空间里,
  以**命名约束**求解;无解时读 unsat core,按「放宽哪一条」
  生成最小修改建议——引擎不返回「无法规划」,返回带代价的选项。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from typing import List, Optional

from z3 import Bool, BoolVal, If, Optimize, Solver, Sum, And, PbEq, unsat

from .model import (
    Candidate,
    Choice,
    TravelRequest,
    evaluate_choice,
    min_to_hhmm,
)

LATEST_ARRIVE_STAY_MIN = 18 * 60  # 「当天能开始休整」的合理下限


@dataclass
class Suggestion:
    """一条最小修改建议:放宽什么、结果如何、代价是什么。"""

    relax: List[str]
    text: str
    resulting: Optional[dict] = None


@dataclass
class WishPoolEntry:
    """不可行憧憬的归宿(D1 §5.1 铁律第 4 条):不说「不」,说「现在不行」。"""

    candidate_id: str
    name: str
    conditions: dict
    reason: str


@dataclass
class Verdict:
    candidate_id: str
    name: str
    feasible: bool
    imagery_match: float
    choice: Optional[Choice] = None
    true_cost: Optional[TrueCost] = None
    unsat_core: List[str] = field(default_factory=list)
    suggestions: List[Suggestion] = field(default_factory=list)
    wish_pool: Optional[WishPoolEntry] = None

    def to_dict(self) -> dict:
        d = {
            "candidate_id": self.candidate_id,
            "name": self.name,
            "feasible": self.feasible,
            "imagery_match": self.imagery_match,
            "unsat_core": self.unsat_core,
            "suggestions": [{"relax": s.relax, "text": s.text, "resulting": s.resulting} for s in self.suggestions],
        }
        if self.choice:
            d["chosen"] = {
                "out_service": self.choice.out_service.id,
                "out_transfer": self.choice.out_transfer.mode,
                "ret_service": self.choice.ret_service.id,
                "ret_transfer": self.choice.ret_transfer.mode,
                "days": self.choice.days,
            }
        if self.true_cost:
            d["true_cost"] = self.true_cost.to_dict()
        if self.wish_pool:
            d["wish_pool"] = {
                "name": self.wish_pool.name,
                "conditions": self.wish_pool.conditions,
                "reason": self.wish_pool.reason,
            }
        return d


def _exactly_one(bools):
    return PbEq([(b, 1) for b in bools], 1)


class _Encoding:
    """把一个候选目的地编码成 Z3 问题(选择变量 + 命名约束)。"""

    def __init__(self, cand: Candidate, req: TravelRequest, days: Optional[int] = None):
        self.cand = cand
        self.req = req
        self.days = days if days is not None else req.window_days
        mot = req.motivation

        self.sel_o = [Bool(f"o{i}") for i in range(len(cand.services_out))]
        self.sel_t = [Bool(f"t{j}") for j in range(len(cand.dest_transfers))]
        self.sel_r = [Bool(f"r{k}") for k in range(len(cand.services_ret))]
        self.sel_tr = [Bool(f"tr{m}") for m in range(len(cand.dest_transfers))]

        access = req.home_hub_access[cand.hub]

        def pick(sels, values):
            return Sum([If(s, v, 0) for s, v in zip(sels, values)])

        dep_out = pick(self.sel_o, [s.dep_min for s in cand.services_out])
        arr_out = pick(self.sel_o, [s.arr_min for s in cand.services_out])
        price_out = pick(self.sel_o, [s.price_cny for s in cand.services_out])
        transfer_out = pick(self.sel_t, [t.minutes for t in cand.dest_transfers])
        transfer_out_price = pick(self.sel_t, [t.price_cny for t in cand.dest_transfers])
        dep_ret = pick(self.sel_r, [s.dep_min for s in cand.services_ret])
        price_ret = pick(self.sel_r, [s.price_cny for s in cand.services_ret])
        transfer_ret = pick(self.sel_tr, [t.minutes for t in cand.dest_transfers])
        transfer_ret_price = pick(self.sel_tr, [t.price_cny for t in cand.dest_transfers])

        wake = dep_out - cand.buffer_out_min - access.to_hub_min
        arrive_stay = arr_out + transfer_out
        d2d_out = arrive_stay - wake

        # 精力(到达状态):惩罚项与 model.evaluate_choice 保持一致
        wake_pen = If(wake < 5 * 60, 30, If(wake < 6 * 60, 25, If(wake < 6 * 60 + 30, 15, 0)))
        energy = 100 - wake_pen - 2 * 8 \
            - If(arrive_stay > 21 * 60, 10, 0) \
            - If(d2d_out > 6 * 60, 10, 0)

        day1_raw = If(LATEST_ARRIVE_STAY_MIN + 3 * 60 - arrive_stay > 0,
                      LATEST_ARRIVE_STAY_MIN + 3 * 60 - arrive_stay, 0)  # 21:00 结束
        day1 = day1_raw * (100 + energy) / 200
        leave_stay_ret = dep_ret - cand.buffer_ret_min - transfer_ret
        day2_raw = If(leave_stay_ret - 9 * 60 > 0, leave_stay_ret - 9 * 60, 0)
        day2 = day2_raw * 9 / 10
        mid_days = max(0, self.days - 2)  # 多日行程的中间完整日
        usable = day1 + day2 + mid_days * 8 * 60 * 9 / 10

        money = (price_out + price_ret + transfer_out_price + transfer_ret_price
                 + cand.stay_cny_per_night * (self.days - 1) + cand.local_daily_cny * self.days)

        required_min = int(round(mot.required_usable_hours * 60))

        self.assertions = {
            "wake_floor": wake >= mot.wake_floor_min,
            "energy_floor": energy >= mot.min_arrival_energy_pct,
            "usable_hours": usable >= required_min,
            "budget": money <= req.budget_cny,
            "duration": BoolVal(self.days >= cand.min_days_for_purpose),
            "arrival_before_evening": arrive_stay <= LATEST_ARRIVE_STAY_MIN,
        }
        self.structure = And(
            _exactly_one(self.sel_o), _exactly_one(self.sel_t),
            _exactly_one(self.sel_r), _exactly_one(self.sel_tr),
        )
        self.money_expr = money

    def solver_with(self, skip=()) -> Solver:
        s = Solver()
        s.add(self.structure)
        for name, expr in self.assertions.items():
            if name not in skip:
                s.assert_and_track(expr, name)
        return s

    def extract(self, model) -> Choice:
        def chosen(sels, items):
            for b, item in zip(sels, items):
                if is_true(model.eval(b, model_completion=True)):
                    return item
            raise RuntimeError("no selection in model")

        return Choice(
            out_service=chosen(self.sel_o, self.cand.services_out),
            out_transfer=chosen(self.sel_t, self.cand.dest_transfers),
            ret_service=chosen(self.sel_r, self.cand.services_ret),
            ret_transfer=chosen(self.sel_tr, self.cand.dest_transfers),
            days=self.days,
        )


def is_true(v) -> bool:
    from z3 import BoolRef
    if isinstance(v, BoolRef):
        from z3 import is_true as z3_is_true
        return z3_is_true(v)
    return bool(v)


def _suggest_text(relax: List[str], enc: _Encoding, choice: Choice, cost: TrueCost, req: TravelRequest) -> str:
    """把「放宽集合 + 求解出的具体方案」翻译成人话,代价必须写明。"""
    cand = enc.cand
    mot = req.motivation
    parts: List[str] = []
    if "duration" in relax:
        parts.append(f"把行程延长到 {choice.days} 天({cand.name} 值得这个窗口)")
    if "budget" in relax:
        parts.append(f"预算提高到 ¥{cost.money_cny}(原 ¥{req.budget_cny})")
    if "wake_floor" in relax:
        parts.append(f"接受 {min_to_hhmm(cost.wake_min)} 起床——破坏生物钟,与你的休整动机冲突,不推荐")
    if "energy_floor" in relax:
        parts.append(f"接受到达精力 {cost.energy_arrival_pct}%(低于你要求的 {mot.min_arrival_energy_pct}%)")
    if "usable_hours" in relax:
        parts.append(f"接受有效休整 {cost.usable_hours:.1f}h(低于动机所需的 {mot.required_usable_hours:.1f}h)")
    if "arrival_before_evening" in relax:
        parts.append(f"接受 {min_to_hhmm(cost.arrive_stay_min)} 才到住处")
    plan = (f"可行方案:{choice.out_service.id} {min_to_hhmm(choice.out_service.dep_min)} 出发、"
            f"{choice.out_transfer.mode} 接驳,¥{cost.money_cny},{min_to_hhmm(cost.wake_min)} 起床,"
            f"{min_to_hhmm(cost.arrive_stay_min)} 到住处,到达精力 {cost.energy_arrival_pct}%")
    return " + ".join(parts) + f";{plan}"


def _cheapest_plan(enc: "_Encoding", skip: tuple):
    """在放宽 skip 约束的前提下求**最省钱**的可行方案。

    Optimize 的 model 不保证最优,最优值经 lower(句柄) 取得后,
    用等值约束回代到普通 Solver 提取最优模型——联合建议与
    wish pool 条件共用同一条路径,保证给用户的是最低代价。
    """
    opt = Optimize()
    opt.add(enc.structure)
    for name, expr in enc.assertions.items():
        if name not in skip:
            opt.add(expr)
    obj = opt.minimize(enc.money_expr)
    if opt.check() == unsat:
        return None, None
    best = opt.lower(obj).as_long()
    s = enc.solver_with(skip=skip)
    s.add(enc.money_expr == best)
    if s.check() == unsat:
        return None, None
    ch = enc.extract(s.model())
    return ch, evaluate_choice(enc.cand, enc.req, ch)


def solve_candidate(cand: Candidate, req: TravelRequest) -> Verdict:
    enc = _Encoding(cand, req)
    s = enc.solver_with()
    verdict = Verdict(candidate_id=cand.id, name=cand.name, feasible=False, imagery_match=cand.imagery_match)

    if s.check() != unsat:
        verdict.feasible = True
        verdict.choice = enc.extract(s.model())
        verdict.true_cost = evaluate_choice(cand, req, verdict.choice)
        return verdict

    core = [str(name) for name in s.unsat_core()]
    verdict.unsat_core = sorted(core)

    # 最小修改建议:先试单条放宽,不够再试两两组合(有界搜索)。
    # 注意 days 是数据不是决策变量:放宽 duration 时必须换用目的所需天数重新编码。
    relaxing_sets: List[List[str]] = [[n] for n in core] + [list(p) for p in combinations(core, 2)]
    for skip in relaxing_sets:
        enc2 = _Encoding(cand, req, days=cand.min_days_for_purpose) if "duration" in skip else enc
        s2 = enc2.solver_with(skip=tuple(skip))
        if s2.check() != unsat:
            ch = enc2.extract(s2.model())
            cost = evaluate_choice(cand, req, ch)
            verdict.suggestions.append(Suggestion(
                relax=skip,
                text=_suggest_text(skip, enc2, ch, cost, req),
                resulting={"days": ch.days, **cost.to_dict()},
            ))

    # 组合 core:放宽 duration 换到长窗口口径后,可能暴露新的冲突
    # (如 5 天的预算),用新口径的 unsat core 继续叠加,拼出
    # 「延长天数 + 加预算」式的联合建议——两次求解,而非枚举全部组合。
    # Z3 的 unsat core 不保证极小,叠加后做一轮收缩:逐个试着放回
    # 被放宽的约束,能放回就放回,保证建议只要求用户付出必要代价。
    if "duration" in core:
        long_enc = _Encoding(cand, req, days=cand.min_days_for_purpose)
        s2 = long_enc.solver_with(skip=("duration",))
        if s2.check() == unsat:
            core2 = [str(x) for x in s2.unsat_core()]
            joint = ["duration"] + [n for n in core2 if n != "duration"]
            for name in [n for n in joint if n != "duration"]:
                trial = tuple(n for n in joint if n != name)
                if long_enc.solver_with(skip=trial).check() != unsat:
                    joint = list(trial)
            s3 = long_enc.solver_with(skip=tuple(joint))
            if s3.check() != unsat:
                ch, cost = _cheapest_plan(long_enc, tuple(joint))
                if ch is not None:
                    verdict.suggestions.append(Suggestion(
                        relax=joint,
                        text=_suggest_text(joint, long_enc, ch, cost, req),
                        resulting={"days": ch.days, **cost.to_dict()},
                    ))

    # 憧憬不被拒绝:若「放宽时长」能救活,进 wish pool,并求出它真正需要的条件
    if any("duration" in sg.relax for sg in verdict.suggestions):
        long_enc = _Encoding(cand, req, days=cand.min_days_for_purpose)
        ch, cost = _cheapest_plan(long_enc, ("duration", "budget"))
        conditions = {"days": cand.min_days_for_purpose}
        if ch is not None:
            conditions["budget_cny"] = cost.money_cny
        if cand.best_months:
            conditions["best_months"] = cand.best_months
        verdict.wish_pool = WishPoolEntry(
            candidate_id=cand.id,
            name=cand.name,
            conditions=conditions,
            reason=f"以「{req.motivation.weights}」的动机,{req.window_days} 天窗口装不下这个目的地",
        )
    return verdict


def solve(req: TravelRequest, candidates: List[Candidate]) -> dict:
    verdicts = [solve_candidate(c, req) for c in candidates]
    feasible = sorted([v for v in verdicts if v.feasible], key=lambda v: -v.imagery_match)
    recommended = feasible[0].candidate_id if feasible else None
    return {
        "request": {
            "note": req.note,
            "window_days": req.window_days,
            "budget_cny": req.budget_cny,
            "required_usable_hours": round(req.motivation.required_usable_hours, 1),
        },
        "verdicts": [v.to_dict() for v in verdicts],
        "recommended": recommended,
        "answer_md": render_markdown(req, verdicts, recommended),
    }


def render_markdown(req: TravelRequest, verdicts: List[Verdict], recommended: Optional[str]) -> str:
    feasible = sorted([v for v in verdicts if v.feasible], key=lambda v: -v.imagery_match)
    parked = [v for v in verdicts if not v.feasible]
    lines: List[str] = []
    lines.append(f"> 憧憬:{req.note}")
    lines.append(f"> 已识别约束:窗口 {req.window_days} 天 | 预算 ¥{req.budget_cny} | "
                 f"动机(休整改写需求 {req.motivation.required_usable_hours:.1f}h 有效休整)")
    lines.append("")
    for v in parked:
        lines.append(f"**{v.name}:现在不行**——冲突约束:{'、'.join(v.unsat_core)}。")
        for sg in v.suggestions[:1]:
            lines.append(f"- {sg.text}")
        if v.wish_pool:
            conds = v.wish_pool.conditions
            months = conds.get("best_months")
            season = f",{months} 月最佳" if months else ""
            budget_note = f"、约 ¥{conds['budget_cny']}" if conds.get("budget_cny") else ""
            lines.append(f"- 已放入「下一次出发」清单:需要 {conds.get('days')} 天{budget_note}{season}")
    lines.append("")
    for v in feasible:
        c, t = v.choice, v.true_cost
        lines.append(f"**{v.name}:可行**"
                     f"({c.out_service.id} {min_to_hhmm(c.out_service.dep_min)} 出发,"
                     f"{c.out_transfer.mode} 接驳,{min_to_hhmm(t.arrive_stay_min)} 到住处,"
                     f"起床 {min_to_hhmm(t.wake_min)},到达精力 {t.energy_arrival_pct}%,"
                     f"门到门 {t.door_to_door_out_min // 60}h{t.door_to_door_out_min % 60:02d}m,"
                     f"有效休整 {t.usable_hours:.1f}h,共 ¥{t.money_cny})")
    if feasible:
        lines.append("")
        best = feasible[0]
        alt = feasible[1] if len(feasible) > 1 else None
        lines.append(f"**建议:{best.name}**(意象匹配 {best.imagery_match:.0%})。"
                     + (f"备选:{alt.name}(¥{alt.true_cost.money_cny},匹配 {alt.imagery_match:.0%})。" if alt else ""))
    lines.append("")
    lines.append("**待你决定的两个问题**:")
    if len(feasible) >= 2:
        lines.append(f"1. {feasible[0].name} 还是 {feasible[1].name}?(前者更贴意象,后者更省)")
    elif feasible:
        lines.append(f"1. 就去 {feasible[0].name} 吗?")
    else:
        lines.append("1. 所有候选都不可行——考虑放宽哪条约束?")
    parked_first = parked[0] if parked else None
    if parked_first and parked_first.wish_pool:
        lines.append(f"2. 把 {parked_first.name} 留给「下一次出发」({parked_first.wish_pool.conditions.get('days')} 天起),这次先去可行的?")
    elif feasible:
        c = feasible[0].choice
        lines.append(f"2. 出发班次选 {c.out_service.id}({min_to_hhmm(c.out_service.dep_min)})还是更晚的?")
    return "\n".join(lines)
