"""Multi-leg 行程引擎:leg 链选择 + 锚点约束 + 串联全成本(P0-2)。

与单候选引擎(model/engine)的关系:那套回答「N 个目的地选哪个」,
本模块回答「一条跨日多段行程怎么排、哪个锚点冲突、代价是什么」——
demo 任务(普吉岛 workation)的形态。分层纪律不变:
- 算术在 evaluate_*(纯函数);
- Z3 只做每 leg 的班次选择,锚点为命名约束,无解给 unsat core。

红眼航班(red_eye)专项:睡眠模型 sleep≈飞行时长−1h,
落地精力 = clamp(30 + 8×sleep, 30, 75)——「机场回来直接去上班」的代价可算。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from z3 import Bool, If, Int, Optimize, Solver, Sum, And, unsat

from .model import Service, TransferMode, hhmm_to_min, min_to_hhmm


@dataclass
class JourneyLeg:
    """一段跨城移动:date 固定,services 为当日班次(静态数据包)。"""

    id: str
    note: str = ""
    services: List[Service] = field(default_factory=list)
    buffer_min: int = 90                 # 枢纽前置缓冲(值机/安检)
    origin_transfer_min: int = 60        # 上一活动/住处 → 枢纽
    dest_transfer_min: int = 60          # 枢纽 → 住处/下一活动
    arrive_by_min: Optional[int] = None  # 锚点:最晚到达住处
    depart_after_min: Optional[int] = None  # 锚点:最早出发
    red_eye: bool = False                # 红眼:启用睡眠模型而非普通惩罚
    red_eye_duration_min: int = 0        # 红眼飞行时长(用于睡眠模型)


@dataclass
class JourneyRequest:
    note: str = ""
    legs: List[JourneyLeg] = field(default_factory=list)
    budget_cny: Optional[int] = None
    wake_floor_min: int = hhmm_to_min("06:00")  # 多段行程默认放宽到 6:00(行程型而非纯休整型)


def evaluate_leg(leg: JourneyLeg, svc: Service) -> dict:
    """单 leg 门到门算术(与 model.evaluate_choice 同源的惩罚体系)。"""
    wake = svc.dep_min - leg.buffer_min - leg.origin_transfer_min
    arrive_stay = svc.arr_min + leg.dest_transfer_min
    d2d = arrive_stay - wake
    if leg.red_eye and leg.red_eye_duration_min > 0:
        sleep_h = (leg.red_eye_duration_min - 60) / 60.0
        energy = max(30, min(75, 30 + 8 * sleep_h))
    else:
        energy = 100 - 2 * 8
        if wake < 5 * 60:
            energy -= 30
        elif wake < 6 * 60:
            energy -= 25
        if arrive_stay > 21 * 60:
            energy -= 10
        if d2d > 6 * 60:
            energy -= 10
        energy = max(0, energy)
    return {
        "service": svc.id,
        "dep": min_to_hhmm(svc.dep_min),
        "wake": min_to_hhmm(wake),
        "arrive_stay": min_to_hhmm(arrive_stay),
        "door_to_door": f"{d2d // 60}h{d2d % 60:02d}m",
        "energy_pct": round(energy),
        "price_cny": svc.price_cny,
    }


def _exactly_one(sels):
    return Sum([If(s, 1, 0) for s in sels]) == 1


def solve_journey(req: JourneyRequest) -> dict:
    """每 leg 选一个班次,满足全部锚点命名约束;无解读 core 给放宽建议。"""
    all_sels, assertions = {}, {}
    for leg in req.legs:
        sels = [Bool(f"{leg.id}_s{i}") for i in range(len(leg.services))]
        all_sels[leg.id] = sels

        def pick(attr):
            return Sum([If(s, getattr(svc, attr), 0) for s, svc in zip(sels, leg.services)])

        dep, arr, price = pick("dep_min"), pick("arr_min"), pick("price_cny")
        wake = dep - leg.buffer_min - leg.origin_transfer_min
        arrive_stay = arr + leg.dest_transfer_min

        if leg.arrive_by_min is not None:
            assertions[f"{leg.id}:arrive_by"] = arrive_stay <= leg.arrive_by_min
        if leg.depart_after_min is not None:
            assertions[f"{leg.id}:depart_after"] = dep >= leg.depart_after_min
        if not leg.red_eye:
            assertions[f"{leg.id}:wake_floor"] = wake >= req.wake_floor_min

    total = Sum([If(s, svc.price_cny, 0)
                 for leg in req.legs for s, svc in zip(all_sels[leg.id], leg.services)])
    if req.budget_cny is not None:
        assertions["total:budget"] = total <= req.budget_cny

    s = Solver()
    for sel in all_sels.values():
        s.add(_exactly_one(sel))
    for name, expr in assertions.items():
        s.assert_and_track(expr, name)

    if s.check() != unsat:
        model = s.model()
        chosen = {}
        for leg in req.legs:
            for b, svc in zip(all_sels[leg.id], leg.services):
                if z3_true(model.eval(b, model_completion=True)):
                    chosen[leg.id] = svc
        leg_reports = [evaluate_leg(leg, chosen[leg.id]) for leg in req.legs]
        money = sum(r["price_cny"] for r in leg_reports)
        red_flags = [
            f"{leg.id} 落地精力仅 {r['energy_pct']}%(红眼后直奔事务,当日不宜安排重要会议)"
            for leg, r in zip(req.legs, leg_reports) if leg.red_eye and r["energy_pct"] < 50
        ] + [
            f"{leg.id} 起床 {r['wake']}(早于 6:00,生物钟代价)"
            for leg, r in zip(req.legs, leg_reports)
            if not leg.red_eye and hhmm_to_min(r["wake"]) < 6 * 60
        ]
        return {"feasible": True, "money_cny": money, "legs": leg_reports, "red_flags": red_flags}

    core = sorted(str(c) for c in s.unsat_core())
    suggestions = []
    for name in core:
        s2 = Solver()
        for sel in all_sels.values():
            s2.add(_exactly_one(sel))
        for n2, expr in assertions.items():
            if n2 != name:
                s2.assert_and_track(expr, n2)
        if s2.check() != unsat:
            m2 = s2.model()
            chosen = {}
            for leg in req.legs:
                for b, svc in zip(all_sels[leg.id], leg.services):
                    if z3_true(m2.eval(b, model_completion=True)):
                        chosen[leg.id] = svc
            rep = [evaluate_leg(leg, chosen[leg.id]) for leg in req.legs]
            suggestions.append({
                "relax": name,
                "money_cny": sum(r["price_cny"] for r in rep),
                "legs": [{**r, "leg": leg.id} for leg, r in zip(req.legs, rep)],
            })
    return {"feasible": False, "unsat_core": core, "suggestions": suggestions}


def z3_true(v) -> bool:
    from z3 import is_true as _t
    return _t(v) if hasattr(v, "decl") else bool(v)
