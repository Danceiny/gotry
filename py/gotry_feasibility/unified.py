"""统一行程模型(D2 §3,迁移步 1):行程 = 候选段(Segment)的序列。

修复双引擎裂缝:engine(N 个目的地候选)与 journey(M 段固定链)在此合并——
- 洱海案例 = 1 个 choice 段(3 个目的地 Option);
- demo 行程 = 5 个段(f1 可 choice、f5 fixed)+ stay 段穿插。
本步只做**模型定义与旧输入适配**;求解器改造是迁移步 2,journey 侧为基座。

时间语义(D-5 预留):moments 一律「段内当日分钟 + date + tz」三元组,
适配器先把旧输入的裸 HH:MM 升级为带日期的绝对时刻(此处先记录 tz 待步 2 落实)。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from z3 import Bool, If, Int, Solver, Sum, And, unsat

from .journey import JourneyLeg, evaluate_leg
from .model import (
    Candidate, Choice, HubAccess, MotivationProfile, Service, TransferMode,
    TravelRequest, evaluate_choice, hhmm_to_min,
)


@dataclass
class Anchors:
    """段的硬锚点(命名约束的来源)。"""

    arrive_by_min: Optional[int] = None
    depart_after_min: Optional[int] = None
    min_days: Optional[int] = None
    wake_floor_min: Optional[int] = None


@dataclass
class MoveSpec:
    """一段跨城移动:班次 × 接驳 × 缓冲(journey.JourneyLeg 的超集)。

    候选形态(目的地选项)用 services(去程)+ ret_services(返程)+ transfers;
    航班形态只用 services(单程)。红眼只适用于航班形态。
    """

    hub: str
    services: List[Service]
    ret_services: List[Service] = field(default_factory=list)
    transfers: List[TransferMode] = field(default_factory=list)
    buffer_min: int = 90
    buffer_ret_min: int = 90
    origin_transfer_min: int = 60
    dest_transfer_min: int = 60
    red_eye: bool = False
    red_eye_duration_min: int = 0
    tz_offset_min: int = 0  # D-5:目的地相对出发地的时差(如 KMG-BKK=+60,DXB-SZX=-240)


@dataclass
class StaySpec:
    """住宿块(workation 一等公民;M-1 工作窗口预留)。"""

    nights: int
    stay_cny_per_night: int = 0
    local_daily_cny: int = 0
    work_window: Optional[dict] = None  # {"tz": "UTC+4", "start": "10:00", "end": "19:00"}(M-1)


@dataclass
class SegmentOption:
    """段的一个可选方案:目的地(带 stay)或具体班次组合(仅 move)。"""

    id: str
    label: str
    move: Optional[MoveSpec] = None
    stay: Optional[StaySpec] = None
    score: float = 0.0            # 意象匹配等排序信号
    best_months: List[int] = field(default_factory=list)


@dataclass
class Segment:
    id: str
    role: str                     # choice | fixed
    note: str = ""
    date: Optional[str] = None    # ISO 或说明文本(步 2 落实绝对时刻)
    anchors: Anchors = field(default_factory=Anchors)
    options: List[SegmentOption] = field(default_factory=list)


@dataclass
class JourneySpec:
    """统一行程:段序列 + 全局约束。两个旧引擎的输入都能无损表示。"""

    note: str = ""
    segments: List[Segment] = field(default_factory=list)
    budget_cny: Optional[int] = None
    default_wake_floor_min: int = hhmm_to_min("06:00")
    # 候选形态(单 choice 段)的全局上下文——由适配器从旧 request 填充
    window_days: int = 2
    home_hub_access: dict = field(default_factory=dict)
    min_arrival_energy_pct: int = 40
    required_usable_hours: float = 5.4
    latest_arrive_stay_min: int = 18 * 60


# ---- 适配器 1:旧候选用例(洱海形态:request + candidates)→ 单 choice 段 ------------

def segments_from_candidate(req: dict, candidates: List[Candidate]) -> JourneySpec:
    mot_hard = (req.get("motivation") or {}).get("hard", {})
    weights = (req.get("motivation") or {}).get("weights", {})
    anchors = Anchors(wake_floor_min=hhmm_to_min(mot_hard.get("wake_not_before", "06:30")))
    options = []
    for c in candidates:
        opt = SegmentOption(
            id=c.id, label=c.name, score=c.imagery_match, best_months=c.best_months,
            move=MoveSpec(
                hub=c.hub, services=list(c.services_out), ret_services=list(c.services_ret),
                transfers=list(c.dest_transfers), buffer_min=c.buffer_out_min,
                buffer_ret_min=c.buffer_ret_min,
            ),
            stay=StaySpec(nights=int(req["window_days"]) - 1, stay_cny_per_night=c.stay_cny_per_night,
                          local_daily_cny=c.local_daily_cny),
        )
        opt.__dict__["min_days"] = c.min_days_for_purpose
        options.append(opt)
    escape = float(weights.get("escape_rest", 0.0))
    return JourneySpec(
        note=req.get("note", ""),
        segments=[Segment(id="dest", role="choice", note="目的地选择", anchors=anchors, options=options)],
        budget_cny=req.get("budget_cny"),
        default_wake_floor_min=anchors.wake_floor_min or hhmm_to_min("06:30"),
        window_days=int(req["window_days"]),
        home_hub_access={h: {"hub": h, "to_hub_min": a["to_hub_min"]}
                         for h, a in (req.get("home", {}).get("hubs", {}) or {}).items()},
        min_arrival_energy_pct=int(mot_hard.get("min_arrival_energy_pct", 40)),
        required_usable_hours=4.0 + 2.0 * escape,
    )


# ---- 适配器 2:航班数据包(demo 形态:flights_2026.json)→ 段序列 --------------------

def segments_from_flight_pack(pack: dict) -> JourneySpec:
    segments = []
    for l in pack.get("legs", []):
        services = [Service(s["id"], hhmm_to_min(s["dep"]), hhmm_to_min(s["arr"]), s["price_cny"])
                    for s in l["services"]]
        options = [SegmentOption(
            id=s.id, label=f"{s.id} {l.get('note', '')[:18]}",
            move=MoveSpec(
                hub=str(l.get("hub", "")), services=[s], transfers=[],
                buffer_min=l["buffer_min"], origin_transfer_min=l["origin_transfer_min"],
                dest_transfer_min=l["dest_transfer_min"],
                red_eye=bool(l.get("red_eye", False)),
                red_eye_duration_min=int(l.get("red_eye_duration_min", 0)),
                tz_offset_min=int(l.get("tz_offset_min", 0)),
            ),
        ) for s in services]
        # 每个 Option 携带自身 min_days(候选形态的 Option 级差异,统一表达)
        anchors = Anchors(
            arrive_by_min=hhmm_to_min(l["arrive_by"]) if l.get("arrive_by") else None,
        )
        segments.append(Segment(
            id=l["id"], role="fixed" if len(options) == 1 else "choice",
            note=l.get("note", ""), date=l.get("date"),
            anchors=anchors, options=options,
        ))
    return JourneySpec(note=pack.get("meta", {}).get("note", ""), segments=segments)


# ---- 统一求解器(迁移步 2,骨架:先吃「每 Option 单班次」形态) -------------------------
# 选择变量按 Option 而非班次——这是与旧 journey 求解器的本质区别:
# 统一模型里「选项」就是选择单元(候选目的地或具体班次组合)。
# 候选形态(洱海:Option 含 stay/多班次)的核算泛化是步 2 的下半段。


def _option_service(option: SegmentOption) -> Service:
    assert option.move and len(option.move.services) == 1, \
        f"步2骨架仅支持单班次 Option(每 Option 一个服务),{option.id} 违反"
    return option.move.services[0]


def _option_as_leg(seg: Segment, option: SegmentOption) -> JourneyLeg:
    mv = option.move
    return JourneyLeg(
        id=seg.id, note=seg.note, services=mv.services,
        buffer_min=mv.buffer_min, origin_transfer_min=mv.origin_transfer_min,
        dest_transfer_min=mv.dest_transfer_min,
        arrive_by_min=seg.anchors.arrive_by_min,
        depart_after_min=seg.anchors.depart_after_min,
        red_eye=mv.red_eye, red_eye_duration_min=mv.red_eye_duration_min,
    )


def _exactly_one(sels):
    return Sum([If(s, 1, 0) for s in sels]) == 1


def solve_unified(spec: JourneySpec) -> dict:
    """按 Option 选择求解段链;锚点命名约束;无解读 core 给逐锚点放宽建议。"""
    all_sels: dict = {}
    assertions: dict = {}

    for seg in spec.segments:
        sels = [Bool(f"{seg.id}_o{i}") for i in range(len(seg.options))]
        all_sels[seg.id] = sels
        svc_of = [_option_service(o) for o in seg.options]

        def pick(attr):
            return Sum([If(s, getattr(sv, attr), 0) for s, sv in zip(sels, svc_of)])

        dep, arr = pick("dep_min"), pick("arr_min")
        o0 = seg.options[0]
        wake = dep - o0.move.buffer_min - o0.move.origin_transfer_min
        arrive_stay = arr + o0.move.dest_transfer_min

        if seg.anchors.arrive_by_min is not None:
            assertions[f"{seg.id}:arrive_by"] = arrive_stay <= seg.anchors.arrive_by_min
        if seg.anchors.depart_after_min is not None:
            assertions[f"{seg.id}:depart_after"] = dep >= seg.anchors.depart_after_min
        wake_floor = seg.anchors.wake_floor_min or spec.default_wake_floor_min
        if not any(o.move.red_eye for o in seg.options):
            assertions[f"{seg.id}:wake_floor"] = wake >= wake_floor

    total = Sum([If(s, _option_service(o).price_cny, 0)
                 for seg in spec.segments for s, o in zip(all_sels[seg.id], seg.options)])
    if spec.budget_cny is not None:
        assertions["total:budget"] = total <= spec.budget_cny

    s = Solver()
    for sel in all_sels.values():
        s.add(_exactly_one(sel))
    for name, expr in assertions.items():
        s.assert_and_track(expr, name)

    def _report(model):
        chosen = {}
        for seg in spec.segments:
            for b, o in zip(all_sels[seg.id], seg.options):
                from z3 import is_true
                if is_true(model.eval(b, model_completion=True)):
                    chosen[seg.id] = o
        reports = []
        for seg in spec.segments:
            reports.append({"leg": seg.id, **_evaluate_option_move(seg, chosen[seg.id])})
        return chosen, reports

    if s.check() != unsat:
        chosen, reports = _report(s.model())
        money = sum(r["price_cny"] for r in reports)
        red_flags = [
            f"{r['leg']} 落地精力仅 {r['energy_pct']}%(红眼后直奔事务,当日不宜安排重要会议)"
            for r in reports if any(o.move.red_eye for o in next(sg for sg in spec.segments if sg.id == r["leg"]).options)
            and r["energy_pct"] < 50
        ]
        return {"feasible": True, "money_cny": money, "legs": reports, "red_flags": red_flags}

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
            _, reports = _report(s2.model())
            suggestions.append({"relax": name, "money_cny": sum(r["price_cny"] for r in reports), "legs": reports})
    return {"feasible": False, "unsat_core": core, "suggestions": suggestions}


# ---- 候选形态求解(步 2b):枚举 + 算术过滤 ---------------------------------------
# 规模注记(ADR 级):Option 内部组合 ≤ 班次×接驳² ×返程,个位数到几十,
# 枚举过滤与 Z3 判定等价且可读性更好;航班链形态仍走 Z3(锚点归因)。


def _checks(t, spec):
    """对一次组合的 TrueCost 跑全部命名约束,返回失败约束名列表。"""
    fails = []
    if t.wake_min < spec.default_wake_floor_min:
        fails.append("wake_floor")
    if t.energy_arrival_pct < spec.min_arrival_energy_pct:
        fails.append("energy_floor")
    if t.usable_hours < spec.required_usable_hours:
        fails.append("usable_hours")
    if spec.budget_cny is not None and t.money_cny > spec.budget_cny:
        fails.append("budget")
    if t.arrive_stay_min > spec.latest_arrive_stay_min:
        fails.append("arrival_before_evening")
    return fails


def _option_candidate(opt: SegmentOption) -> Candidate:
    mv, st = opt.move, opt.stay
    return Candidate(
        id=opt.id, name=opt.label, hub=mv.hub,
        buffer_out_min=mv.buffer_min, buffer_ret_min=mv.buffer_ret_min,
        services_out=list(mv.services), services_ret=list(mv.ret_services or mv.services),
        dest_transfers=list(mv.transfers),
        stay_cny_per_night=st.stay_cny_per_night, local_daily_cny=st.local_daily_cny,
        min_days_for_purpose=int(opt.__dict__.get("min_days", 1)),
        imagery_match=opt.score, best_months=list(opt.best_months),
    )


def _enumerate(opt, cand, req, spec, days):
    out = []
    mv = opt.move
    for o in mv.services:
        for tr in mv.transfers:
            for r in (mv.ret_services or mv.services):
                for trr in mv.transfers:
                    ch = Choice(out_service=o, out_transfer=tr, ret_service=r, ret_transfer=trr, days=days)
                    t = evaluate_choice(cand, req, ch)
                    out.append((ch, t, _checks(t, spec)))
    return out


def solve_choice_segment(spec: JourneySpec) -> dict:
    """单 choice 段(目的地选项):逐 Option 枚举过滤,按 score 排序,兼容旧 engine 输出。"""
    seg = next(s for s in spec.segments if s.role == "choice" and s.options and s.options[0].stay)
    req = TravelRequest(
        note=spec.note,
        motivation=MotivationProfile(
            weights={}, wake_floor_min=spec.default_wake_floor_min,
            min_arrival_energy_pct=spec.min_arrival_energy_pct,
            base_usable_hours=spec.required_usable_hours, escape_hours_per_weight=0.0),
        window_days=spec.window_days, budget_cny=spec.budget_cny,
        home_hub_access={h: HubAccess(h, a["to_hub_min"]) for h, a in spec.home_hub_access.items()},
    )
    verdicts = []
    for opt in seg.options:
        cand = _option_candidate(opt)
        min_days = cand.min_days_for_purpose
        duration_ok = spec.window_days >= min_days
        combos = _enumerate(opt, cand, req, spec, spec.window_days) if duration_ok else []
        good = [c for c in combos if not c[2]]
        if good:
            ch, t, _ = min(good, key=lambda c: c[1].money_cny)
            verdicts.append({
                "candidate_id": opt.id, "name": opt.label, "feasible": True, "imagery_match": opt.score,
                "chosen": {"out_service": ch.out_service.id, "out_transfer": ch.out_transfer.mode,
                           "ret_service": ch.ret_service.id, "ret_transfer": ch.ret_transfer.mode,
                           "days": ch.days},
                "true_cost": {"money_cny": t.money_cny, "wake": f"{t.wake_min//60:02d}:{t.wake_min%60:02d}",
                              "energy_arrival_pct": t.energy_arrival_pct,
                              "usable_hours": round(t.usable_hours, 1)},
            })
            continue
        # 不可行:归因(哪条约束单独放宽可解) + duration 换长口径的最省钱条件
        blocked = sorted({n for c in (combos or []) for n in c[2]}) or (["duration"] if not duration_ok else [])
        suggestions = []
        for name in blocked:
            opened = [c for c in combos if name not in c[2]]
            if opened:
                ch, t, _ = min(opened, key=lambda c: c[1].money_cny)
                suggestions.append({"relax": name, "resulting_money_cny": t.money_cny})
        wish = None
        if not duration_ok:
            long_combos = [c for c in _enumerate(opt, cand, req, spec, min_days) if not c[2]]
            budget_dropped = [c for c in _enumerate(opt, cand, req, spec, min_days)
                              if set(_checks_t(c[1], spec)) <= {"budget"} or not _checks_t(c[1], spec)]
            conds = {"days": min_days}
            if budget_dropped:
                conds["budget_cny"] = min(c[1].money_cny for c in budget_dropped)
            if opt.best_months:
                conds["best_months"] = opt.best_months
            wish = {"name": opt.label, "conditions": conds,
                    "reason": f"{spec.window_days} 天窗口装不下(目的需 {min_days} 天)"}
        verdicts.append({
            "candidate_id": opt.id, "name": opt.label, "feasible": False, "imagery_match": opt.score,
            "unsat_core": blocked, "suggestions": suggestions, "wish_pool": wish,
        })
    feasible = sorted([v for v in verdicts if v["feasible"]], key=lambda v: -v["imagery_match"])
    return {"verdicts": verdicts, "recommended": feasible[0]["candidate_id"] if feasible else None}


def _checks_t(t, spec):
    return _checks(t, spec)


def _evaluate_option_move(seg: Segment, option: SegmentOption) -> dict:
    """D-5:时区感知的段核算(取代对 deprecated evaluate_leg 的委托)。

    语义:wake 与 arrive_stay 保持**各自当地时刻**(呈现正确);
    door_to_door = 出发侧前置(值机+接驳) + **真实飞行时长**(含时差) + 到达侧接驳。
    """
    mv = option.move
    svc = mv.services[0]
    wake = svc.dep_min - mv.buffer_min - mv.origin_transfer_min
    # 真实时长 = 到达(当地) − 出发(当地) − 时差(dest−origin);EK329: 215−(−240)=455min=7h35m ✓
    true_flight = (svc.arr_min - svc.dep_min) - mv.tz_offset_min
    d2d = mv.buffer_min + mv.origin_transfer_min + true_flight + mv.dest_transfer_min
    wake_display = f"{(wake + 1440) // 60 % 24:02d}:{(wake + 1440) % 60:02d}(前一日)" if wake < 0 \
        else f"{wake // 60:02d}:{wake % 60:02d}"
    arrive_stay = svc.arr_min + mv.dest_transfer_min

    if mv.red_eye and mv.red_eye_duration_min > 0:
        sleep_h = (mv.red_eye_duration_min - 60) / 60.0
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
        "service": svc.id, "dep": f"{svc.dep_min // 60:02d}:{svc.dep_min % 60:02d}",
        "wake": wake_display, "wake_min": wake,
        "arrive_stay": f"{arrive_stay // 60:02d}:{arrive_stay % 60:02d}",
        "door_to_door": f"{d2d // 60}h{d2d % 60:02d}m", "d2d_min": d2d,
        "energy_pct": round(energy), "price_cny": svc.price_cny,
    }
