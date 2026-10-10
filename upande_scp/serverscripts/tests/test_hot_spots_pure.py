"""Hot spots piece 3b — the pure rules. Plain pytest, no site."""

import unittest

from upande_scp.serverscripts.common import threshold_bands as B

BANDS = {"low": 5, "mod": 20, "high": 50}


def cell(row, col, scouted, pct=None, avg=None):
    return {"row": row, "col": col, "scouted": scouted, "infested": 0, "pct": pct, "avg": avg}


def hot(house, sections, bands=BANDS, measure=B.PERCENTAGE):
    return [(h["row"], h["col"], h["band"]) for h in B.hotspots(house, sections, bands, measure)]


class TestHotspots(unittest.TestCase):
    def test_a_higher_band_at_least_moderate_with_five_stations_is_hot(self):
        sections = [cell(0, 0, 5, 80.0), cell(0, 1, 5, 25.0), cell(1, 1, 5, 0.0)]
        self.assertEqual(hot(8.9, sections), [(0, 0, "high"), (0, 1, "moderate")])

    def test_an_equal_band_is_not_hot(self):
        self.assertEqual(hot(60.0, [cell(0, 0, 9, 80.0)]), [])          # both High
        self.assertEqual(hot(25.0, [cell(0, 0, 9, 30.0)]), [])          # both Moderate
        self.assertEqual(hot(25.0, [cell(0, 0, 9, 80.0)]), [(0, 0, "high")])

    def test_four_stations_are_not_enough(self):
        self.assertEqual(B.HOTSPOT_MIN_N, 5)
        self.assertEqual(hot(0.0, [cell(0, 0, 4, 100.0)]), [])
        self.assertEqual(hot(0.0, [cell(0, 0, 5, 100.0)]), [(0, 0, "high")])

    def test_a_low_section_above_a_clean_house_is_not_hot(self):
        self.assertEqual(hot(0.0, [cell(0, 0, 9, 10.0)]), [])           # Low is not ≥ Moderate

    def test_misordered_or_unset_bands_give_nothing(self):
        sections = [cell(0, 0, 9, 80.0)]
        self.assertEqual(hot(1.0, sections, {"low": 1, "mod": 0.4, "high": 2}), [])
        self.assertEqual(hot(1.0, sections, {"low": 0, "mod": 0, "high": 0}), [])

    def test_no_house_figure_gives_nothing(self):
        self.assertEqual(hot(None, [cell(0, 0, 9, 80.0)]), [])
        self.assertEqual(B.section_readings(None, [cell(0, 0, 9, 80.0)], BANDS, B.PERCENTAGE), [])

    def test_a_section_without_a_figure_is_skipped(self):
        # Fewer than 3 stations scouted → pct None: no reading at all (it neither
        # raises nor resolves a hot spot).
        readings = B.section_readings(8.9, [cell(0, 0, 2, None), cell(1, 1, 5, 0.0)], BANDS, B.PERCENTAGE)
        self.assertEqual([(r["row"], r["col"], r["hot"]) for r in readings], [(1, 1, False)])

    def test_a_count_row_reads_the_section_average(self):
        sections = [cell(0, 0, 6, pct=10.0, avg=3.0), cell(0, 1, 6, pct=90.0, avg=0.2)]
        self.assertEqual(hot(0.4, sections, {"low": 0.5, "mod": 1, "high": 2}, B.COUNT), [(0, 0, "high")])

    def test_readings_carry_value_scouted_band_and_reliability(self):
        r = B.section_readings(8.9, [cell(2, 1, 12, 80.0)], BANDS, B.PERCENTAGE)[0]
        self.assertEqual(r, {"row": 2, "col": 1, "value": 80.0, "scouted": 12, "band": "high",
                             "reliability": "Good", "hot": True})


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

    def test_hot_spots_sort_with_alarming_and_types_are_named(self):
        self.assertEqual((B.HOUSE, B.HOT_SPOT), ("House", "Hot spot"))
        self.assertEqual(B.ALERT_RANK[B.HOT_SPOT], B.ACTION_RANK[B.ALARMING])
        self.assertEqual(B.ALERT_RANK[B.SPRAY_ADVISED], B.ACTION_RANK[B.SPRAY_ADVISED])
        self.assertFalse(B.escalates(None, B.HOT_SPOT))   # a hot spot never rides the action ladder
