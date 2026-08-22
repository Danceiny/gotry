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
from .model import Candidate, Service, TransferMode, hhmm_to_min


@dataclass
class Anchors:
    """段的硬锚点(命名约束的来源)。"""

    arrive_by_min: Optional[int] = None
    depart_after_min: Optional[int] = None
    min_days: Optional[int] = None
    wake_floor_min: Optional[int] = None


@dataclass
class MoveSpec:
    """一段跨城移动:班次 × 接驳 × 缓冲(journey.JourneyLeg 的超集)。"""

    hub: str
    services: List[Service]
    transfers: List[TransferMode] = field(default_factory=list)
    buffer_min: int = 90
    origin_transfer_min: int = 60
    dest_transfer_min: int = 60
    red_eye: bool = False
    red_eye_duration_min: int = 0


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


# ---- 适配器 1:旧候选用例(洱海形态:request + candidates)→ 单 choice 段 ------------

def segments_from_candidate(req: dict, candidates: List[Candidate]) -> JourneySpec:
    mot = (req.get("motivation") or {}).get("hard", {})
    anchors = Anchors(
        wake_floor_min=hhmm_to_min(mot.get("wake_not_before", "06:30")),
        min_days=None,  # min_days 是 Option 级(每个目的地不同),不是段级
    )
    options = []
    for c in candidates:
        options.append(SegmentOption(
            id=c.id, label=c.name, score=c.imagery_match, best_months=c.best_months,
            move=MoveSpec(
                hub=c.hub, services=c.services_out + c.services_ret,
                transfers=c.destTransfers if hasattr(c, "destTransfers") else c.dest_transfers,
                buffer_min=c.buffer_out_min,
            ),
            stay=StaySpec(nights=req["window_days"] - 1, stay_cny_per_night=c.stay_cny_per_night,
                          local_daily_cny=c.local_daily_cny),
        ))
        # Option 级差异(min_days)挂在 anchors 之外,由 min_days 字段承载:
        options[-1].move  # noqa: B018(占位注释:steps2 会把 min_days 移入 option 约束)
        options[-1].__dict__["min_days"] = c.min_days_for_purpose
    return JourneySpec(
        note=req.get("note", ""),
        segments=[Segment(id="dest", role="choice", note="目的地选择", anchors=anchors, options=options)],
        budget_cny=req.get("budget_cny"),
        default_wake_floor_min=anchors.wake_floor_min or hhmm_to_min("06:30"),
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
            leg = _option_as_leg(seg, chosen[seg.id])
            reports.append({"leg": seg.id, **evaluate_leg(leg, _option_service(chosen[seg.id]))})
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
