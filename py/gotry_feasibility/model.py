"""Gotry 可行性引擎领域模型(D1 §6.5 全成本 / §7.5 可行性引擎的落地)。

设计原则:
- 「成本的真实单位是生命体验」:每段跨城移动按门到门全成本计价
  (班次约束/前置缓冲/生物钟代价/接驳导航/到达状态/金钱)。
- 「为什么出发」决定钱-时间-精力的兑换率:动机权重生成硬约束
  (起床下限、到达精力下限、有效休整时长需求),引擎按动机计价。
- 精力/时长参数是**可校准的初始值**,不是真理;校准数据源之一是共享经验层(D1 §6.6)。

时间一律用「当日分钟数」(00:00 起)表示;班次假定为当日到达(PoC 数据范围内成立)。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


def hhmm_to_min(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def min_to_hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


@dataclass
class TransferMode:
    """到/离枢纽的接驳方式(taxi/bus 等),带时间与金钱代价。"""

    mode: str
    minutes: int
    price_cny: int

    @staticmethod
    def from_dict(d: dict) -> "TransferMode":
        return TransferMode(d["mode"], int(d["min"]), int(d["price_cny"]))


@dataclass
class Service:
    """一个可选班次(航班/高铁),门到门模型的「班次约束」载体。"""

    id: str
    dep_min: int
    arr_min: int
    price_cny: int

    @staticmethod
    def from_dict(d: dict) -> "Service":
        return Service(d["id"], hhmm_to_min(d["dep"]), hhmm_to_min(d["arr"]), int(d["price_cny"]))


@dataclass
class HubAccess:
    """家↔枢纽的通行(前置缓冲的一部分,决定起床时刻)。"""

    hub: str
    to_hub_min: int


@dataclass
class MotivationProfile:
    """动机画像的最小可行形态:权重谱系 + 由动机推出的硬约束。

    required_usable_hours = 4 + 2 × escape_rest(逃离休整权重):
    休整动机越强,对「有效休整时长」的需求越高——兑换率的引擎表达。
    """

    weights: Dict[str, float]
    wake_floor_min: int = hhmm_to_min("06:30")
    min_arrival_energy_pct: int = 40
    base_usable_hours: float = 4.0
    escape_hours_per_weight: float = 2.0

    @property
    def required_usable_hours(self) -> float:
        return self.base_usable_hours + self.escape_hours_per_weight * self.weights.get("escape_rest", 0.0)

    @staticmethod
    def from_dict(d: dict) -> "MotivationProfile":
        hard = d.get("hard", {})
        return MotivationProfile(
            weights={k: float(v) for k, v in d.get("weights", d).items() if isinstance(v, (int, float))},
            wake_floor_min=hhmm_to_min(hard.get("wake_not_before", "06:30")),
            min_arrival_energy_pct=int(hard.get("min_arrival_energy_pct", 40)),
        )


@dataclass
class Candidate:
    """候选目的地:意象匹配度 + 班次/接驳/花费数据 + 目的性最短天数。"""

    id: str
    name: str
    hub: str
    buffer_out_min: int
    buffer_ret_min: int
    services_out: List[Service]
    services_ret: List[Service]
    dest_transfers: List[TransferMode]
    stay_cny_per_night: int
    local_daily_cny: int
    min_days_for_purpose: int
    imagery_match: float
    best_months: List[int] = field(default_factory=list)

    @staticmethod
    def from_dict(d: dict) -> "Candidate":
        return Candidate(
            id=d["id"],
            name=d["name"],
            hub=d["hub"],
            buffer_out_min=int(d.get("buffer_out_min", 60)),
            buffer_ret_min=int(d.get("buffer_ret_min", 60)),
            services_out=[Service.from_dict(s) for s in d["services_out"]],
            services_ret=[Service.from_dict(s) for s in d["services_ret"]],
            dest_transfers=[TransferMode.from_dict(t) for t in d["dest_transfers"]],
            stay_cny_per_night=int(d["stay_cny_per_night"]),
            local_daily_cny=int(d["local_daily_cny"]),
            min_days_for_purpose=int(d["min_days_for_purpose"]),
            imagery_match=float(d["imagery_match"]),
            best_months=[int(m) for m in d.get("best_months", [])],
        )


@dataclass
class TravelRequest:
    """一次「憧憬」的结构化:动机 + 窗口 + 预算 + 素材备注。"""

    note: str
    motivation: MotivationProfile
    window_days: int
    budget_cny: int
    home_hub_access: Dict[str, HubAccess]

    @staticmethod
    def from_dict(d: dict) -> "TravelRequest":
        hubs = {
            hub: HubAccess(hub, int(acc["to_hub_min"]))
            for hub, acc in d.get("home", {}).get("hubs", {}).items()
        }
        return TravelRequest(
            note=d.get("note", ""),
            motivation=MotivationProfile.from_dict(d["motivation"]),
            window_days=int(d["window_days"]),
            budget_cny=int(d["budget_cny"]),
            home_hub_access=hubs,
        )


@dataclass
class Choice:
    """引擎的一个具体选择(用于求解后取回具体数字)。"""

    out_service: Service
    out_transfer: TransferMode
    ret_service: Service
    ret_transfer: TransferMode
    days: int


@dataclass
class TrueCost:
    """门到门全成本(D1 §6.5 六要素的可计算形态)。"""

    money_cny: int
    wake_min: int
    arrive_stay_min: int
    door_to_door_out_min: int
    energy_arrival_pct: int
    usable_hours: float
    usable_day1_hours: float
    usable_day2_hours: float
    depart_home_ret_min: int
    arrive_home_ret_min: int

    def to_dict(self) -> dict:
        return {
            "money_cny": self.money_cny,
            "wake": min_to_hhmm(self.wake_min),
            "arrive_stay": min_to_hhmm(self.arrive_stay_min),
            "door_to_door_out": f"{self.door_to_door_out_min // 60}h{self.door_to_door_out_min % 60:02d}m",
            "energy_arrival_pct": self.energy_arrival_pct,
            "usable_hours": round(self.usable_hours, 1),
            "usable_day1_hours": round(self.usable_day1_hours, 1),
            "usable_day2_hours": round(self.usable_day2_hours, 1),
            "leave_stay_return": min_to_hhmm(self.depart_home_ret_min),
            "arrive_home_return": min_to_hhmm(min(1440, self.arrive_home_ret_min)),
        }


# ---- 精力模型(可校准参数) -------------------------------------------------
# 「到达状态模型」:精力 = 100 − Σ惩罚。惩罚项全部来自门到门六要素,
# 数值是初始校准值,后续用共享经验层回流数据校准(D1 §6.6)。
WAKE_PENALTY_BEFORE_5 = 30      # <05:00 起床:生物钟重度破坏
WAKE_PENALTY_BEFORE_6 = 25      # 05:00-06:00
WAKE_PENALTY_BEFORE_630 = 15    # 06:00-06:30
TRANSFER_PENALTY = 8            # 每一段换乘/接驳
LATE_ARRIVAL_PENALTY = 10       # 21:00 后才到住处
LONG_D2D_PENALTY = 10           # 单程门到门超过 6 小时
DAY_END_MIN = 21 * 60           # 「一天结束」的默认时刻
DAY2_START_MIN = 9 * 60         # 返程日有效时间起点
DAY2_QUALITY = 0.9              # 返程日时间折算系数


def evaluate_choice(cand: Candidate, req: TravelRequest, ch: Choice) -> TrueCost:
    """对一个具体选择做纯算术的门到门全成本核算。

    这里不碰 Z3——所有算术集中在此,Z3 只负责「选哪个」,
    两个层次可以互相独立测试。
    """
    access = req.home_hub_access[cand.hub]
    wake = ch.out_service.dep_min - cand.buffer_out_min - access.to_hub_min
    arrive_stay = ch.out_service.arr_min + ch.out_transfer.minutes
    d2d_out = arrive_stay - wake

    # 精力(到达状态)
    energy = 100
    if wake < 5 * 60:
        energy -= WAKE_PENALTY_BEFORE_5
    elif wake < 6 * 60:
        energy -= WAKE_PENALTY_BEFORE_6
    elif wake < hhmm_to_min("06:30"):
        energy -= WAKE_PENALTY_BEFORE_630
    energy -= 2 * TRANSFER_PENALTY  # 出发侧:家→枢纽 + 目的地接驳
    if arrive_stay > 21 * 60:
        energy -= LATE_ARRIVAL_PENALTY
    if d2d_out > 6 * 60:
        energy -= LONG_D2D_PENALTY
    energy = max(0, energy)

    # 有效休整时长(兑换率的输出侧):Day1 由到达状态决定质量,Day2 被返程截断,
    # 多日行程的中间日按完整可用日计(约 8 有效小时/日)
    day1_raw = max(0, DAY_END_MIN - arrive_stay) / 60.0
    day1 = day1_raw * (0.5 + energy / 200.0)
    leave_stay_ret = ch.ret_service.dep_min - cand.buffer_ret_min - ch.ret_transfer.minutes
    day2 = max(0, leave_stay_ret - DAY2_START_MIN) / 60.0 * DAY2_QUALITY
    mid_days = max(0, ch.days - 2)
    usable = day1 + day2 + mid_days * 8.0 * DAY2_QUALITY

    money = (
        ch.out_service.price_cny + ch.ret_service.price_cny
        + ch.out_transfer.price_cny + ch.ret_transfer.price_cny
        + cand.stay_cny_per_night * (ch.days - 1)
        + cand.local_daily_cny * ch.days
    )
    arrive_home_ret = ch.ret_service.arr_min + access.to_hub_min

    return TrueCost(
        money_cny=money,
        wake_min=wake,
        arrive_stay_min=arrive_stay,
        door_to_door_out_min=d2d_out,
        energy_arrival_pct=energy,
        usable_hours=usable,
        usable_day1_hours=day1,
        usable_day2_hours=day2,
        depart_home_ret_min=leave_stay_ret,
        arrive_home_ret_min=arrive_home_ret,
    )
