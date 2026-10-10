"""Hot spots piece 3b — the pure rules. Plain pytest, no site."""

import unittest

from upande_scp.serverscripts.common import threshold_bands as B

BANDS = {"low": 5, "mod": 20, "high": 50}


def cell(row, col, scouted, infested=0, avg=None):
    """A Percentage section: ``infested`` of ``scouted``; ``pct`` as piece 2
    computes it (None below 3 stations)."""
    pct = round(infested / scouted * 100, 1) if scouted >= 3 else None
    return {"row": row, "col": col, "scouted": scouted, "infested": infested, "pct": pct, "avg": avg}


def hot(house, sections, bands=BANDS, measure=B.PERCENTAGE):
    return [(h["row"], h["col"], h["band"]) for h in B.hotspots(house, sections, bands, measure)]


class TestWilsonLower(unittest.TestCase):
    """Hand-checked: (p + z²/2n − z·sqrt(p(1−p)/n + z²/4n²)) / (1 + z²/n), z = 1.96."""

    def test_hand_checked_values(self):
        self.assertEqual(B.wilson_lower(3, 5), 23.1)
        self.assertEqual(B.wilson_lower(4, 5), 37.6)
        self.assertEqual(B.wilson_lower(5, 5), 56.6)
        self.assertEqual(B.wilson_lower(5, 9), 26.7)
        self.assertEqual(B.wilson_lower(9, 9), 70.1)
        self.assertEqual(B.wilson_lower(12, 12), 75.7)

    def test_none_without_stations_and_zero_when_clean(self):
        self.assertIsNone(B.wilson_lower(0, 0))
        self.assertIsNone(B.wilson_lower(1, None))
        self.assertEqual(B.wilson_lower(0, 5), 0.0)


class TestHotspots(unittest.TestCase):
    """A Percentage section is judged on the band of its Wilson 95 % lower
    bound (final review, 2026-10-10); its value stays the observed pct."""

    def test_three_of_five_is_noise_five_of_five_is_a_moderate_hot_spot(self):
        bands = {"low": 5, "mod": 30, "high": 60}
        self.assertEqual(hot(11.1, [cell(0, 0, 5, 3)], bands), [])           # 60 % seen, lower 23.1 % Low
        self.assertEqual(hot(11.1, [cell(0, 0, 5, 5)], bands), [(0, 0, "moderate")])   # lower 56.6 %

    def test_a_higher_band_at_least_moderate_with_five_stations_is_hot(self):
        sections = [cell(0, 0, 5, 5), cell(0, 1, 5, 4), cell(1, 1, 5, 0)]
        self.assertEqual(hot(8.9, sections), [(0, 0, "high"), (0, 1, "moderate")])

    def test_an_equal_band_is_not_hot(self):
        self.assertEqual(hot(60.0, [cell(0, 0, 9, 9)]), [])             # both High (lower 70.1)
        self.assertEqual(hot(25.0, [cell(0, 0, 9, 5)]), [])             # both Moderate (lower 26.7)
        self.assertEqual(hot(25.0, [cell(0, 0, 9, 9)]), [(0, 0, "high")])

    def test_four_stations_are_not_enough(self):
        self.assertEqual(B.HOTSPOT_MIN_N, 5)
        self.assertEqual(hot(0.0, [cell(0, 0, 4, 4)]), [])
        self.assertEqual(hot(0.0, [cell(0, 0, 5, 5)]), [(0, 0, "high")])

    def test_a_low_section_above_a_clean_house_is_not_hot(self):
        self.assertEqual(hot(0.0, [cell(0, 0, 9, 1)]), [])              # Low is not ≥ Moderate

    def test_misordered_or_unset_bands_give_nothing(self):
        sections = [cell(0, 0, 9, 9)]
        self.assertEqual(hot(1.0, sections, {"low": 1, "mod": 0.4, "high": 2}), [])
        self.assertEqual(hot(1.0, sections, {"low": 0, "mod": 0, "high": 0}), [])

    def test_no_house_figure_gives_nothing(self):
        self.assertEqual(hot(None, [cell(0, 0, 9, 9)]), [])
        self.assertEqual(B.section_readings(None, [cell(0, 0, 9, 9)], BANDS, B.PERCENTAGE), [])

    def test_a_section_without_a_figure_is_skipped(self):
        # Fewer than 3 stations scouted → pct None: no reading at all (it neither
        # raises nor resolves a hot spot).
        readings = B.section_readings(8.9, [cell(0, 0, 2, 2), cell(1, 1, 5, 0)], BANDS, B.PERCENTAGE)
        self.assertEqual([(r["row"], r["col"], r["hot"]) for r in readings], [(1, 1, False)])

    def test_a_count_row_reads_the_section_average(self):
        sections = [cell(0, 0, 6, 1, avg=3.0), cell(0, 1, 6, 5, avg=0.2)]
        self.assertEqual(hot(0.4, sections, {"low": 0.5, "mod": 1, "high": 2}, B.COUNT), [(0, 0, "high")])

    def test_readings_carry_value_scouted_band_and_reliability(self):
        r = B.section_readings(8.9, [cell(2, 1, 12, 12)], BANDS, B.PERCENTAGE)[0]
        self.assertEqual(r, {"row": 2, "col": 1, "value": 100.0, "lower": 75.7, "scouted": 12, "band": "high",
                             "reliability": "Good", "hot": True})
        c = B.section_readings(0.4, [cell(0, 0, 6, 1, avg=3.0)], {"low": 0.5, "mod": 1, "high": 2}, B.COUNT)[0]
        self.assertEqual((c["value"], c["lower"], c["band"], c["hot"]), (3.0, None, "high", True))


class TestSectionRules(unittest.TestCase):
    def test_section_reliability_by_n(self):
        self.assertEqual([B.section_reliability(n) for n in (0, 4, 5, 9, 10)],
                         ["Low", "Low", "Fair", "Fair", "Good"])

    def test_band_escalation_is_moderate_to_high_only(self):
        self.assertTrue(B.band_escalates(None, "Moderate"))
        self.assertTrue(B.band_escalates("Moderate", "High"))
        self.assertFalse(B.band_escalates("High", "High"))
        self.assertFalse(B.band_escalates("High", "Moderate"))
        self.assertFalse(B.band_escalates(None, "Low"))

    def test_section_label_speaks_beds_or_rows(self):
        self.assertEqual(B.section_unit("zone"), "bed")
        self.assertEqual(B.section_unit("tree"), "row")
        self.assertEqual(B.section_label(0, 0, "bed"), "first beds · front")
        self.assertEqual(B.section_label(1, 1, "bed"), "middle beds · middle")
        self.assertEqual(B.section_label(2, 2, "row"), "last rows · back")
        self.assertEqual(B.section_label(3, 0, "bed"), "")
        self.assertEqual(B.section_label(-1, -1), "")
        self.assertEqual(B.section_label(0, -1), "")

    def test_hot_spots_sort_with_alarming_and_types_are_named(self):
        self.assertEqual((B.HOUSE, B.HOT_SPOT), ("House", "Hot spot"))
        self.assertEqual(B.ALERT_RANK[B.HOT_SPOT], B.ACTION_RANK[B.ALARMING])
        self.assertEqual(B.ALERT_RANK[B.SPRAY_ADVISED], B.ACTION_RANK[B.SPRAY_ADVISED])
        self.assertFalse(B.escalates(None, B.HOT_SPOT))   # a hot spot never rides the action ladder
