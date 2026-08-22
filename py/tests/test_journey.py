"""multi-leg 引擎的最小验证(demo 行程的骨架场景)。"""

from __future__ import annotations

import unittest

from gotry_feasibility.journey import JourneyLeg, JourneyRequest, Service, solve_journey, hhmm_to_min


def leg_hkg_hkt():
    return JourneyLeg(
        id="f1", note="7.18 香港办证后飞普吉",
        services=[
            Service("CX769", hhmm_to_min("14:05"), hhmm_to_min("17:15"), 2100),
            Service("HX763", hhmm_to_min("19:40"), hhmm_to_min("22:50"), 1500),
        ],
        buffer_min=90, origin_transfer_min=75, dest_transfer_min=45,
        arrive_by_min=hhmm_to_min("23:59"),
    )


def leg_szx_dxb():
    return JourneyLeg(
        id="f5", note="8.10 凌晨红眼回迪拜直奔办公室",
        services=[Service("EK828", hhmm_to_min("23:55"), hhmm_to_min("05:50"), 3200)],
        buffer_min=120, origin_transfer_min=60, dest_transfer_min=45,
        arrive_by_min=hhmm_to_min("07:00"), red_eye=True, red_eye_duration_min=8 * 60 + 35,
    )


class TestJourney(unittest.TestCase):
    def test_chained_selection_with_anchors(self):
        """两段串联:办证日班次满足到达锚点,总钱数正确。"""
        r = solve_journey(JourneyRequest(note="demo", legs=[leg_hkg_hkt(), leg_szx_dxb()], budget_cny=6000))
        self.assertTrue(r["feasible"])
        f1 = r["legs"][0]
        self.assertIn(f1["service"], {"CX769", "HX763"})
        self.assertLessEqual(hhmm_to_min(f1["arrive_stay"]), hhmm_to_min("23:59"))
        self.assertEqual(r["money_cny"], f1["price_cny"] + 3200)

    def test_red_eye_energy_and_flag(self):
        """红眼睡眠模型:8.5h 飞行 → 精力 30+8×7.5=90 → clamp 75?不,clamp 上限 75。"""
        r = solve_journey(JourneyRequest(legs=[leg_szx_dxb()]))
        self.assertTrue(r["feasible"])
        # sleep=(515-60)/60≈7.6h → 30+8×7.6≈91 → clamp 75:全成本说『可以上班但别安排重活』
        self.assertEqual(r["legs"][0]["energy_pct"], 75)
        # 上限 75 < 50 为假 → 无红旗;改用紧预算断言红旗机制在 budget 场景生效(见下)
        self.assertEqual(r["red_flags"], [])

    def test_red_eye_flag_when_poor_sleep(self):
        """短红眼(4h 飞行,睡 3h → 精力 54)触发 <50?不:54>50。构造 3h 飞行:睡 2h → 46 → 红旗。"""
        leg = JourneyLeg(
            id="fX", services=[Service("REDEYE1", hhmm_to_min("23:30"), hhmm_to_min("02:30"), 900)],
            buffer_min=90, origin_transfer_min=60, dest_transfer_min=30,
            red_eye=True, red_eye_duration_min=3 * 60,
        )
        r = solve_journey(JourneyRequest(legs=[leg]))
        self.assertTrue(r["feasible"])
        self.assertEqual(r["legs"][0]["energy_pct"], 46)
        self.assertTrue(any("红眼" in f or "精力" in f for f in r["red_flags"]))

    def test_anchor_conflict_reports_core(self):
        """锚点冲突:把到达锚点收紧到不可能 → unsat core 点名该锚点并给放宽方案。"""
        leg = leg_hkg_hkt()
        leg.arrive_by_min = hhmm_to_min("15:00")  # 两个班次都到不了
        r = solve_journey(JourneyRequest(legs=[leg]))
        self.assertFalse(r["feasible"])
        self.assertIn("f1:arrive_by", r["unsat_core"])
        self.assertTrue(r["suggestions"])
        self.assertEqual(r["suggestions"][0]["relax"], "f1:arrive_by")

    def test_budget_conflict_names_budget(self):
        leg = leg_hkg_hkt()
        r = solve_journey(JourneyRequest(legs=[leg], budget_cny=1000))
        self.assertFalse(r["feasible"])
        self.assertIn("total:budget", r["unsat_core"])
        self.assertTrue(any(s["relax"] == "total:budget" for s in r["suggestions"]))


if __name__ == "__main__":
    unittest.main()
