"""统一模型迁移步 1 的验证:两种旧输入无损映射为 JourneySpec。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from gotry_feasibility.model import Candidate
from gotry_feasibility.unified import segments_from_candidate, segments_from_flight_pack

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


if __name__ == "__main__":
    unittest.main()
