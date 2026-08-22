"""金标准用例测试:洱海案例(D1 §4.3 故事四 / §5.1 铁律的机器判定)。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from gotry_feasibility import Candidate, TravelRequest, solve
from gotry_feasibility.engine import solve_candidate

DATA = Path(__file__).resolve().parents[2] / "data" / "golden_erhai.json"


def load():
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    req = TravelRequest.from_dict(payload["request"])
    candidates = [Candidate.from_dict(c) for c in payload["candidates"]]
    return payload, req, candidates


class TestGoldenErhai(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, cls.req, cls.candidates = load()
        cls.by_id = {c.id: c for c in cls.candidates}
        cls.result = solve(cls.req, cls.candidates)
        cls.verdicts = {v["candidate_id"]: v for v in cls.result["verdicts"]}

    def test_dali_infeasible_on_duration(self):
        """洱海在周末窗口不可行,且 unsat core 必须点名 duration——引擎知道是目的装不下,不是别的。"""
        v = self.verdicts["dali"]
        self.assertFalse(v["feasible"])
        self.assertIn("duration", v["unsat_core"])

    def test_dali_goes_to_wish_pool_with_conditions(self):
        """憧憬不被拒绝:进 wish pool,带成行条件(天数/预算/季节)。"""
        v = self.verdicts["dali"]
        wp = v["wish_pool"]
        self.assertIsNotNone(wp)
        self.assertGreaterEqual(wp["conditions"]["days"], 5)
        self.assertIn("budget_cny", wp["conditions"])
        self.assertTrue(wp["conditions"]["best_months"])

    def test_dali_suggestion_names_the_tradeoff(self):
        """最小修改建议必须写明代价(延长天数/加预算),不是空话。"""
        v = self.verdicts["dali"]
        self.assertTrue(v["suggestions"])
        joined = " ".join(s["text"] for s in v["suggestions"])
        self.assertIn("天", joined)

    def test_qiandao_feasible_and_recommended(self):
        """千岛湖可行且被推荐(可行集中意象匹配最高)。"""
        v = self.verdicts["qiandao"]
        self.assertTrue(v["feasible"])
        self.assertEqual(self.result["recommended"], "qiandao")

    def test_qiandao_true_cost_shape(self):
        """全成本六要素齐全:钱/起床/到达/门到门/精力/有效时长。"""
        t = self.verdicts["qiandao"]["true_cost"]
        self.assertLessEqual(t["money_cny"], 3000)
        self.assertGreaterEqual(int(t["wake"].replace(":", "")), 630)  # 不早于 06:30
        self.assertGreaterEqual(t["energy_arrival_pct"], 40)
        self.assertGreaterEqual(t["usable_hours"], self.req.motivation.required_usable_hours)

    def test_taihu_feasible_cheaper(self):
        """太湖也可行,更便宜但匹配更低——对比信息完整。"""
        v = self.verdicts["taihu"]
        self.assertTrue(v["feasible"])
        q = self.verdicts["qiandao"]["true_cost"]
        self.assertLessEqual(v["true_cost"]["money_cny"], q["money_cny"])

    def test_answer_is_not_a_blank_no(self):
        """回答里没有「无法规划」式的空手而归:必有可行项或有条件的 wish pool。"""
        md = self.result["answer_md"]
        self.assertIn("千岛湖", md)
        self.assertIn("下一次出发", md)
        self.assertIn("待你决定的两个问题", md)


class TestBudgetRelaxation(unittest.TestCase):
    """预算恰好差一口气的场景:引擎应给出「差多少」而非拒绝。"""

    def test_tight_budget_reports_gap(self):
        payload, req, candidates = load()
        payload["request"]["budget_cny"] = 900  # 千岛湖也要 ~¥1000
        req = TravelRequest.from_dict(payload["request"])
        v = solve_candidate(self_by_id(candidates, "qiandao"), req)
        self.assertFalse(v.feasible)
        self.assertIn("budget", v.unsat_core)
        texts = " ".join(s.text for s in v.suggestions)
        self.assertIn("预算提高到", texts)


def self_by_id(candidates, cid):
    return next(c for c in candidates if c.id == cid)


if __name__ == "__main__":
    unittest.main()
