"""组装完整行程规划书:数据包 + 引擎联算 → docs/demo-plan(P0-4)。

这是 GoTry 第一个可用 demo 的交付物生成器:
- 航程表来自 solve_journey(真实班期数据包,Z3 选班+锚点校验);
- 住宿与预算来自 hotels 数据包的三档;
- gates 以选择题呈现(不替用户决定),数据缺口诚实标注为估算。
运行:PYTHONPATH=py .venv/bin/python -m gotry_demo.build_plan
"""

from __future__ import annotations

import json
from pathlib import Path

from gotry_feasibility.journey import JourneyLeg, JourneyRequest, Service, solve_journey, hhmm_to_min

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "demo-plan-2026-07-17.md"


def load_legs() -> list[JourneyLeg]:
    d = json.loads((ROOT / "data" / "flights_2026.json").read_text(encoding="utf-8"))
    legs = []
    for l in d["legs"]:
        legs.append(JourneyLeg(
            id=l["id"], note=l["note"],
            services=[Service(s["id"], hhmm_to_min(s["dep"]), hhmm_to_min(s["arr"]), s["price_cny"]) for s in l["services"]],
            buffer_min=l["buffer_min"], origin_transfer_min=l["origin_transfer_min"],
            dest_transfer_min=l["dest_transfer_min"],
            arrive_by_min=hhmm_to_min(l["arrive_by"]) if l.get("arrive_by") else None,
            red_eye=l.get("red_eye", False), red_eye_duration_min=l.get("red_eye_duration_min", 0),
        ))
    return legs


def main() -> None:
    flights = json.loads((ROOT / "data" / "flights_2026.json").read_text(encoding="utf-8"))
    hotels = json.loads((ROOT / "data" / "hotels_2026.json").read_text(encoding="utf-8"))
    result = solve_journey(JourneyRequest(note="demo 全链", legs=load_legs(), budget_cny=9000))
    assert result["feasible"], f"全链不可行:{result.get('unsat_core')}"

    lines: list[str] = []
    A = lines.append
    A("# GoTry 行程规划书:普吉岛 workation(2026-07-17 ~ 08-10)")
    A("")
    A("> 首个可用 demo 交付。航程经 Z3 可行性引擎选班与锚点校验;价格为公开渠道估算(标记于数据包);")
    A("> 待决问题以选择题呈现,不替你决定。日期为 2026 年(重放场景)。")
    A("")
    A("## 一、五段航程(引擎已选班,锚点全过)")
    A("")
    A("| 段 | 航班 | 起飞 | 起床/出发 | 到住处/下一站 | 到达精力 | 票价 |")
    A("|---|---|---|---|---|---|---|")
    for lg, meta in zip(result["legs"], flights["legs"]):
        A(f"| {meta['id']} {meta['note'][:22]} | {lg['service']} | {lg['dep']} | {lg['wake']} | {lg['arrive_stay']} | {lg['energy_pct']}% | ¥{lg['price_cny']} |")
    A(f"| **合计** | | | | | | **¥{result['money_cny']}** |")
    A("")
    A("关键核算:")
    A("- **8.10 凌晨回迪拜可行性:✅**。EK329 00:45 起飞 → 04:20 落地 DXB,09:00 上班前余量 4.5h;")
    A("  睡眠模型(机上约 6.6h 睡眠)落地精力 **75%**——能上班,但当日不宜安排重要会议/大决策。")
    A("- **7.18 办证日节奏:✅ 且紧**。银行 09:00-12:00 办结,12:15 离开港岛赶 CX773(14:45);")
    A("  若办证拖到午后,自动降级 HX741(20:20)——当晚 23:50 到普吉,会合推迟但行程不破。")
    A("- **负例防护**:昆明→深圳的深夜班(22:40→01:20)已被引擎排除——赶不上红眼值机。")
    A("")
    A("## 二、住宿推荐")
    A("")
    for s in hotels["stays"]:
        A(f"### {s['id']}:{s['note']}")
        for o in s.get("options", []):
            price = o.get("price_cny") or (o.get("price_per_night_cny", 0) * s["nights"]) or o.get("total_cny", 0)
            A(f"- **{o['tier']}** {o['name']} — 约 ¥{price}" + (f"({o['price_per_night_cny']}/晚)" if o.get("price_per_night_cny") else "") + (f":{o['why']}" if o.get("why") else ""))
        if s.get("recommendation"):
            A(f"- **推荐**:{s['recommendation']}")
        if s.get("key_finding") or s.get("location_decision"):
            A(f"- 选址:{s.get('location_decision', hotels['meta'].get('key_finding', ''))}")
        A("")
    A("## 三、分层总预算(机票 ¥%d 已含)" % result["money_cny"])
    A("")
    for tier in ("经济", "舒适"):
        b = hotels["budget_tiers_summary"][tier]
        A(f"- **{tier}**:约 **¥{b['total']:,}**(机票 ¥{b['flights']:,} + 住宿 ¥{b['hotels']:,})")
    A("")
    A("## 四、待你决定( gates,选择题)")
    A("")
    A("1. **预算档位**:经济 ¥12.6k / 舒适 ¥16.3k?(差价主要花在普吉两周的办公质量上)")
    A("2. **『万xx』换防地**:研究建议——**甲米·奥南**(生活便利+潜水近,季风季出海备选多)> 考拉克")
    A("   (Similan 潜点 5-10 月闭岛,7 月去意义减半)> 董里(更便宜更安静但交通远)。也可不换防,13 晚全住查龙。")
    A("3. **去曼谷的时机**:7.31 周五晚 TG216(最大化周末,workation 当天 16:55 收工)/ 8.1 周六早 VZ303(多一夜普吉,省 ¥400)?")
    A("4. **云南环线**:昆明进 → 大理 2 晚 → 丽江 2 晚 → 昆明 1 晚(经典)/ 大理深度 4 晚 + 昆明 2 晚(洱海慢住,与本次动机更贴)?")
    A("")
    A("## 五、数据与边界(诚实清单)")
    A("")
    A("- 班期为公开渠道的真实时刻(数据包内附来源);**价格均为估算**,预订前需实时报价;")
    A("- 7-8 月为安达曼海季风季,潜水出海受天气影响大,普吉本岛东侧潜点(皇帝岛/珊瑚岛方向)更稳;")
    A("- 泰国免签政策与香港办证材料为**前置检查项**,不在引擎范围;")
    A("- 引擎未建模特的:签证、保险细节、女朋友的独立行程。")
    A("")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"written: {OUT} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
