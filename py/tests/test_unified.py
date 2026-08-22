"""统一模型迁移步 1 的验证:两种旧输入无损映射为 JourneySpec。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from gotry_feasibility.model import Candidate
from gotry_feasibility.unified import (
    segments_from_candidate,
    segments_from_flight_pack,
    solve_choice_segment,
    solve_unified,
)
from gotry_feasibility import solve as legacy_solve
from gotry_feasibility.model import TravelRequest

ROOT = Path(__file__).resolve().parents[2]


class TestAdapters(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.erhai = json.loads((ROOT / "data" / "golden_erhai.json").read_text(encoding="utf-8"))
        cls.pack = json.loads((ROOT / "data" / "flights_2026.json").read_text(encoding="utf-8"))

    def test_candidate_case_becomes_single_choice_segment(self):
        """洱海形态 → 1 个 choice 段、3 个 Option,预算与起床锚点保留。"""
        req = self.erhai["request"]
        candidates = [Candidate.from_dict(c) for c in self.erhai["candidates"]]
        spec = segments_from_candidate(req, candidates)
        self.assertEqual(len(spec.segments), 1)
        seg = spec.segments[0]
        self.assertEqual(seg.role, "choice")
        self.assertEqual(len(seg.options), 3)
        self.assertEqual(spec.budget_cny, 3000)
        self.assertEqual(seg.anchors.wake_floor_min, 6 * 60 + 30)
        ids = {o.id for o in seg.options}
        self.assertEqual(ids, {"dali", "qiandao", "taihu"})
        dali = next(o for o in seg.options if o.id == "dali")
        self.assertEqual(dali.__dict__["min_days"], 5)
        self.assertTrue(dali.stay and dali.stay.nights == 1)

    def test_flight_pack_becomes_segment_chain(self):
        """demo 形态 → 5 段,锚点与红眼标记保留,DZ6252 负例在选项里。"""
        spec = segments_from_flight_pack(self.pack)
        self.assertEqual(len(spec.segments), 5)
        by_id = {s.id: s for s in spec.segments}
        self.assertEqual(by_id["f1"].role, "choice")
        self.assertEqual(by_id["f5"].role, "fixed")
        self.assertEqual(by_id["f5"].anchors.arrive_by_min, 8 * 60 + 30)
        f5_opt = by_id["f5"].options[0]
        self.assertTrue(f5_opt.move.red_eye)
        self.assertEqual(f5_opt.move.red_eye_duration_min, 455)
        f4_ids = {o.id for o in by_id["f4"].options}
        self.assertIn("DZ6252", f4_ids)  # 负例保留,由求解器(步2)排除
        f1_anchor = by_id["f1"].anchors.arrive_by_min
        self.assertEqual(f1_anchor, 23 * 60 + 59)

    def test_option_counts_preserved(self):
        """选项总数守恒:旧引擎的全部可选班次/候选都进入统一模型。"""
        spec = segments_from_flight_pack(self.pack)
        total_options = sum(len(s.options) for s in spec.segments)
        total_services = sum(len(l["services"]) for l in self.pack["legs"])
        self.assertEqual(total_options, total_services)

    def test_unified_solver_flight_pack(self):
        """统一求解器(步2骨架)吃航班包:可行、锚点过、DZ6252 被排除、与旧 journey 同构。"""
        spec = segments_from_flight_pack(self.pack)
        spec.budget_cny = 9000
        r = solve_unified(spec)
        self.assertTrue(r["feasible"])
        # 有效解区间:各段合法班次的组合(HX741 组合 ¥7,680 ~ 全 CX/ZH 组合 ¥8,550),
        # 求解器在等价解间任取;区间端点来自数据包逐段核验
        self.assertTrue(7680 <= r["money_cny"] <= 8550, f"money={r['money_cny']}")
        chosen_ids = {lg["leg"]: lg["service"] for lg in r["legs"]}
        self.assertNotIn("DZ6252", chosen_ids.values())  # 负例被 arrive_by 锚点排除
        self.assertIn(chosen_ids["f1"], {"CX773", "HX741"})
        self.assertEqual(chosen_ids["f5"], "EK329")

    def test_unified_solver_anchor_and_budget_cores(self):
        """锚点冲突与预算冲突的 core 命名,与旧 journey 行为一致。"""
        spec = segments_from_flight_pack(self.pack)
        spec.segments[0].anchors.arrive_by_min = 15 * 60  # f1 收紧到不可能
        r = solve_unified(spec)
        self.assertFalse(r["feasible"])
        self.assertIn("f1:arrive_by", r["unsat_core"])
        self.assertTrue(any(sg["relax"] == "f1:arrive_by" for sg in r["suggestions"]))

        spec2 = segments_from_flight_pack(self.pack)
        spec2.budget_cny = 1000
        r2 = solve_unified(spec2)
        self.assertFalse(r2["feasible"])
        self.assertIn("total:budget", r2["unsat_core"])

    def test_candidate_shape_equivalence_with_legacy_engine(self):
        """步2b 对账:洱海经统一模型 vs 旧 engine——判定集合、推荐、wish 条件一致。"""
        candidates = [Candidate.from_dict(c) for c in self.erhai["candidates"]]
        spec = segments_from_candidate(self.erhai["request"], candidates)
        unified = solve_choice_segment(spec)

        legacy = legacy_solve(TravelRequest.from_dict(self.erhai["request"]), candidates)

        self.assertEqual(unified["recommended"], legacy["recommended"])  # qiandao
        u = {v["candidate_id"]: v for v in unified["verdicts"]}
        l = {v["candidate_id"]: v for v in legacy["verdicts"]}
        self.assertEqual({k: v["feasible"] for k, v in u.items()},
                         {k: v["feasible"] for k, v in l.items()})  # dali✗/qiandao✓/taihu✓
        self.assertIn("duration", u["dali"]["unsat_core"])
        self.assertEqual(u["dali"]["wish_pool"]["conditions"]["days"],
                         l["dali"]["wish_pool"]["conditions"]["days"])
        self.assertEqual(u["dali"]["wish_pool"]["conditions"]["budget_cny"],
                         l["dali"]["wish_pool"]["conditions"]["budget_cny"])  # 最优值一致
        self.assertLessEqual(u["qiandao"]["true_cost"]["money_cny"], 3000)


if __name__ == "__main__":
    unittest.main()
