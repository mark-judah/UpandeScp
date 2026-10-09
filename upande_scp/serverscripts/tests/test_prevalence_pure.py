"""The station-prevalence measure — runs under plain pytest, no site."""

import unittest

from upande_scp.serverscripts.common import prevalence as P


def grid_of(beds: int, zones: int) -> dict:
    """beds × zones stations named B{b}-Z{z}, numbered in order."""
    return P.grid_positions(
        {"name": f"B{b}-Z{z}", "group": f"B{b}", "group_no": b, "no": z}
        for b in range(1, beds + 1)
        for z in range(1, zones + 1)
    )


def by_section(grid: dict) -> dict:
    out: dict = {}
    for name, pos in grid.items():
        out.setdefault(pos, []).append(name)
    return {k: sorted(v, key=lambda n: (int(n.split("-Z")[0][1:]), int(n.split("-Z")[1])))
            for k, v in out.items()}


class TestGrid(unittest.TestCase):
    def test_grid_for_uneven_beds_of_1_2_and_13_zones(self):
        stations = [{"name": "A1", "group": "Bed 1", "group_no": 1, "no": 1}]
        stations += [{"name": f"B{z}", "group": "Bed 2", "group_no": 2, "no": z} for z in (1, 2)]
        stations += [{"name": f"C{z}", "group": "Bed 3", "group_no": 3, "no": z} for z in range(1, 14)]
        grid = P.grid_positions(stations)
        self.assertEqual(len(grid), 16)
        self.assertEqual(grid["A1"], (0, 0))
        self.assertEqual((grid["B1"], grid["B2"]), ((1, 0), (1, 1)))
        self.assertEqual([grid[f"C{z}"][1] for z in range(1, 14)], [0] * 5 + [1] * 4 + [2] * 4)
        self.assertEqual({grid[f"C{z}"][0] for z in range(1, 14)}, {2})

    def test_fewer_than_three_beds_still_places_every_zone(self):
        two = grid_of(2, 3)
        self.assertEqual(len(two), 6)
        self.assertEqual({p[0] for p in two.values()}, {0, 1})
        one = grid_of(1, 3)
        self.assertEqual(sorted(one.values()), [(0, 0), (0, 1), (0, 2)])

    def test_rows_of_one_or_two_trees_map_into_the_grid(self):
        # Orchard Tree.tree is 0 on every tree on kaitet.local: the number comes from the name.
        trees = [("Row 1", 1), ("Row 2", 2), ("Row 3", 10)]
        stations = [
            {"name": f"BLK_ROW{r[-1]}_T{t}", "group": f"BLK - {r}",
             "group_no": P.station_number(None, f"BLK - {r}"),
             "no": P.station_number(0, f"BLK_ROW{r[-1]}_T{t}")}
            for r, n in trees for t in range(1, n + 1)
        ]
        grid = P.grid_positions(stations)
        self.assertEqual(len(grid), 13)
        self.assertEqual(grid["BLK_ROW1_T1"], (0, 0))
        self.assertEqual((grid["BLK_ROW2_T1"], grid["BLK_ROW2_T2"]), ((1, 0), (1, 1)))
        self.assertEqual(grid["BLK_ROW3_T10"], (2, 2))

    def test_station_number_prefers_the_int_column_then_the_name(self):
        self.assertEqual(P.station_number(5, "Zone 9"), 5)
        self.assertEqual(P.station_number("88", "Bed 88"), 88)
        self.assertEqual(P.station_number(0, "70HA_KINYOROBLK4_ROW6_T38"), 38)
        self.assertEqual(P.station_number(None, "AIRSTRIP BLK 1 - KL - Row 10"), 10)
        self.assertIsNone(P.station_number("7a", "Chepsito GH 01 - KR - Bed 7a"))
        self.assertIsNone(P.station_number(None, ""))

    def test_unparsable_numbers_fall_back_to_name_order(self):
        stations = []
        for bed in ("Bed 10", "Bed 2", "Bed X"):
            for zone in ("Zone B", "Zone A"):
                stations.append({"name": f"{bed} - {zone}", "group": bed,
                                 "group_no": P.station_number(None, bed), "no": None})
        grid = P.grid_positions(stations)
        self.assertEqual(len(grid), 6)                       # never dropped
        self.assertEqual(grid["Bed 2 - Zone A"][0], 0)       # numbered beds first, 2 before 10
        self.assertEqual(grid["Bed 10 - Zone A"][0], 1)
        self.assertEqual(grid["Bed X - Zone A"][0], 2)       # unnumbered last
        self.assertEqual((grid["Bed X - Zone A"][1], grid["Bed X - Zone B"][1]), (0, 1))  # name order


class TestFigures(unittest.TestCase):
    def test_even_scouting_is_good_with_a_narrow_margin(self):
        grid = grid_of(30, 30)                                # 100 stations per section
        sec = by_section(grid)
        scouted = {n for names in sec.values() for n in names[:30]}
        infested = {n for names in sec.values() for n in names[:3]}
        fig = P.figures(grid, scouted, infested)
        self.assertEqual((fig["stations"], fig["scouted"], fig["infested"]), (900, 270, 27))
        # Agresti–Coull floor: p̃ = 29/274 → 1.96·sqrt(0.09464/270) = 0.0367 (was 3.6 with p).
        self.assertEqual((fig["raw"], fig["prevalence"], fig["margin"]), (10.0, 10.0, 3.7))
        self.assertEqual((fig["sections_scouted"], fig["sections_total"]), (9, 9))
        self.assertEqual((fig["reliability"], fig["reason"]), ("Good", None))
        self.assertEqual(fig["coverage"], 30.0)

    def test_scouting_in_one_corner_is_too_clustered_to_judge(self):
        grid = grid_of(30, 30)
        corner = by_section(grid)[(0, 0)]
        fig = P.figures(grid, set(corner[:10]), set(corner[:4]))
        self.assertEqual((fig["sections_scouted"], fig["prevalence"]), (1, 40.0))
        self.assertIsNone(fig["margin"])
        self.assertEqual((fig["reason"], fig["reliability"]), (P.CLUSTERED, "Low"))

    def test_one_hot_section_moves_prevalence_by_a_ninth_and_raw_by_its_share(self):
        grid = grid_of(30, 30)
        sec = by_section(grid)
        scouted, infested = set(), set()
        for pos, names in sec.items():
            if pos == (1, 1):
                scouted |= set(names[:50])
                infested |= set(names[:25])
            else:
                scouted |= set(names[:10])
        fig = P.figures(grid, scouted, infested)
        self.assertEqual(fig["prevalence"], round(50 / 9, 1))      # 5.6: one section of nine at 50%
        self.assertEqual(fig["raw"], round(25 / 130 * 100, 1))     # 19.2: its 50 of 130 stations
        # s²/m = 0.02778/9; p̃ = 27/134 → p̃(1−p̃)/130 = 0.001238 → 1.96·sqrt(0.004324)
        # = 0.1289 (was 11.6 with p = 1/18).
        self.assertEqual((fig["margin"], fig["reliability"]), (12.9, "Fair"))

    def test_sections_under_three_scouted_are_not_scouted(self):
        grid = grid_of(30, 30)
        sec = by_section(grid)
        scouted, infested = set(), set()
        for pos, names in sec.items():
            if pos == (2, 2):
                scouted |= set(names[:2])
                infested |= set(names[:2])
            else:
                scouted |= set(names[:3])
                infested |= set(names[:1])
        fig = P.figures(grid, scouted, infested)
        corner = next(s for s in fig["sections"] if (s["row"], s["col"]) == (2, 2))
        self.assertEqual((corner["scouted"], corner["infested"], corner["pct"]), (2, 2, None))
        self.assertEqual(fig["sections_scouted"], 8)
        self.assertEqual(fig["prevalence"], 33.3)                   # the 2/2 corner stays out
        self.assertEqual(fig["raw"], round(10 / 26 * 100, 1))       # but raw counts it

    def test_the_users_800_400_200_example_reads_50_percent(self):
        grid = grid_of(80, 10)
        scouted = {f"B{b}-Z{z}" for b in range(1, 81) for z in range(1, 6)}
        infested = {f"B{b}-Z{z}" for b in range(1, 81) for z in (1, 3)}
        infested |= {f"B{b}-Z5" for b in range(1, 81) if b % 2}
        fig = P.figures(grid, scouted, infested)
        self.assertEqual((fig["stations"], fig["scouted"], fig["infested"]), (800, 400, 200))
        self.assertEqual((fig["raw"], fig["coverage"]), (50.0, 50.0))

    def test_no_section_reaching_three_falls_back_to_raw(self):
        grid = grid_of(30, 30)
        sec = by_section(grid)
        scouted = {names[0] for names in sec.values()}            # one per section
        fig = P.figures(grid, scouted, set(list(sorted(scouted))[:3]))
        self.assertEqual((fig["sections_scouted"], fig["prevalence"], fig["raw"]), (0, 33.3, 33.3))
        self.assertIsNone(fig["margin"])
        self.assertEqual((fig["reason"], fig["reliability"]), (P.CLUSTERED, "Low"))

    def test_no_stations_set_up(self):
        fig = P.figures({}, {"Z1"}, {"Z1"})
        self.assertIsNone(fig["prevalence"])
        self.assertEqual((fig["reason"], fig["reliability"], fig["stations"]), (P.NO_STATIONS, "Low", 0))

    def test_nothing_scouted_is_omitted(self):
        self.assertIsNone(P.figures(grid_of(3, 3), set(), set()))

    def test_infested_outside_the_scouted_set_is_ignored(self):
        grid = grid_of(3, 3)
        fig = P.figures(grid, {"B1-Z1"}, {"B1-Z1", "B2-Z2"})
        self.assertEqual(fig["infested"], 1)

    def test_percentages_are_rounded_to_one_decimal(self):
        grid = grid_of(9, 9)
        sec = by_section(grid)
        scouted = {n for names in sec.values() for n in names[:3]}
        infested = {names[0] for names in sec.values()}
        fig = P.figures(grid, scouted, infested)
        # s² = 0; p̃ = 11/31 → 1.96·sqrt(0.22893/27) = 0.1805 (was 17.8 with p = 1/3).
        self.assertEqual((fig["prevalence"], fig["margin"]), (33.3, 18.0))
        self.assertTrue(all(s["pct"] == 33.3 for s in fig["sections"]))

    def test_precomputed_scouted_counts_give_the_same_answer(self):
        grid = grid_of(9, 9)
        sec = by_section(grid)
        scouted = {n for names in sec.values() for n in names[:3]}
        infested = {names[0] for names in sec.values()}
        self.assertEqual(
            P.figures(grid, scouted, infested, scouted_counts=P.section_counts(grid, scouted)),
            P.figures(grid, scouted, infested),
        )

    def test_all_clean_sections_never_read_plus_minus_zero(self):
        # Margin floor (spec Clarifications): X = 0 of N = 27 over m = 9 sections,
        # s² = 0, p̃ = (0 + 2) / (27 + 4) = 2/31 → 1.96·sqrt(p̃(1−p̃)/27) = 0.0927.
        grid = grid_of(9, 9)
        scouted = {n for names in by_section(grid).values() for n in names[:3]}
        fig = P.figures(grid, scouted, set())
        self.assertEqual((fig["prevalence"], fig["raw"], fig["sections_scouted"]), (0.0, 0.0, 9))
        self.assertEqual(fig["margin"], 9.3)
        self.assertGreater(fig["margin"], 0)
        self.assertEqual(fig["reliability"], "Good")                 # m = 9 and 9.3 ≤ 10

    def test_all_infested_sections_never_read_plus_minus_zero(self):
        # X = N = 27: p̃ = 29/31, the mirror of the all-clean case → same 9.3.
        grid = grid_of(9, 9)
        scouted = {n for names in by_section(grid).values() for n in names[:3]}
        fig = P.figures(grid, scouted, set(scouted))
        self.assertEqual((fig["prevalence"], fig["raw"]), (100.0, 100.0))
        self.assertEqual((fig["margin"], fig["reliability"]), (9.3, "Good"))

    def test_a_thin_all_clean_sample_is_not_good(self):
        # m = 2 sections of 3 → N = 6: p̃ = 2/10 → 1.96·sqrt(0.16/6) = 0.320 → Low.
        grid = grid_of(9, 9)
        sec = by_section(grid)
        scouted = set(sec[(0, 0)][:3]) | set(sec[(2, 2)][:3])
        fig = P.figures(grid, scouted, set())
        self.assertEqual((fig["prevalence"], fig["margin"], fig["reliability"]), (0.0, 32.0, "Low"))

    def test_reliability_bands(self):
        self.assertEqual(P.reliability(7, 0.10), "Good")
        self.assertEqual(P.reliability(7, 0.11), "Fair")
        self.assertEqual(P.reliability(9, None), "Fair")
        self.assertEqual(P.reliability(4, 0.5), "Fair")
        self.assertEqual(P.reliability(3, 0.01), "Low")


class TestCombine(unittest.TestCase):
    def fig(self, stations, prevalence, margin, rel, scouted=10, infested=1):
        return {"stations": stations, "scouted": scouted, "infested": infested,
                "coverage": 10.0, "raw": 10.0, "prevalence": prevalence, "margin": margin,
                "sections_scouted": 9, "sections_total": 9, "reliability": rel,
                "reason": None, "sections": []}

    def test_combine_weights_by_station_count(self):
        out = P.combine([self.fig(100, 10.0, 4.0, "Good"), self.fig(300, 30.0, 6.0, "Fair")])
        self.assertEqual((out["prevalence"], out["margin"]), (25.0, 4.6))
        self.assertEqual((out["reliability"], out["stations"], out["houses"]), ("Fair", 400, 2))
        self.assertEqual((out["sections_scouted"], out["sections_total"]), (18, 18))

    def test_one_too_clustered_house_leaves_the_margin_unknown(self):
        out = P.combine([self.fig(100, 10.0, None, "Low"), self.fig(300, 30.0, 6.0, "Good")])
        self.assertIsNone(out["margin"])
        self.assertEqual((out["reason"], out["reliability"]), (P.CLUSTERED, "Low"))

    def test_combine_with_a_raw_fallback_house_has_no_margin(self):
        # Boundary: a clean, well-spread house (margin 9.3, floored above 0) next to
        # a house whose sections all hold < 3 scouted stations (m = 0, raw fallback,
        # margin None). The prevalence still combines; the margin is unknown.
        grid = grid_of(9, 9)
        sec = by_section(grid)
        clean = P.figures(grid, {n for names in sec.values() for n in names[:3]}, set())
        one_each = {names[0] for names in sec.values()}
        fallback = P.figures(grid, one_each, set(sorted(one_each)[:3]))
        self.assertEqual((clean["margin"], fallback["margin"], fallback["prevalence"]), (9.3, None, 33.3))
        out = P.combine([clean, fallback])
        self.assertEqual(out["prevalence"], round((81 * 0.0 + 81 * 33.3) / 162, 1))   # 16.6
        self.assertIsNone(out["margin"])
        self.assertEqual((out["reason"], out["reliability"]), (P.CLUSTERED, "Low"))

    def test_combine_of_clean_houses_keeps_a_floor(self):
        grid = grid_of(9, 9)
        clean = P.figures(grid, {n for names in by_section(grid).values() for n in names[:3]}, set())
        out = P.combine([clean, dict(clean)])
        # sqrt((81·9.3)² · 2) / 162 = 9.3 / sqrt(2) = 6.58 → 6.6
        self.assertEqual((out["prevalence"], out["margin"]), (0.0, 6.6))

    def test_houses_without_figures_are_skipped(self):
        self.assertIsNone(P.combine([None, P.figures({}, {"a"}, set())]))

    def test_public_fills_the_empty_shape(self):
        self.assertEqual(P.public(None), P.EMPTY)
        self.assertEqual(set(P.public(self.fig(1, 1.0, 1.0, "Good"))), set(P.PUBLIC_KEYS))


class TestWeeks(unittest.TestCase):
    def test_week_labels_cross_the_year_boundary(self):
        self.assertEqual(P.yearweek_label(203253), "2032-W53")
        self.assertEqual(P.yearweek_label("203301"), "2033-W01")
        self.assertEqual(P.yearweek_label(None), "")
        self.assertEqual(P.week_monday("2032-W53"), "2032-12-27")
        self.assertEqual(
            P.latest_and_previous({"2033-W01"}, ["2032-W52", "2032-W53", "2033-W01"]),
            ("2033-W01", "2032-W53"),
        )

    def test_one_week_of_data_has_no_previous(self):
        self.assertEqual(P.latest_and_previous({"2031-W10"}, ["2031-W10"]), ("2031-W10", None))
        self.assertEqual(P.latest_and_previous(set(), ["2031-W10"]), (None, None))

    def test_the_latest_comes_from_the_window_the_previous_from_anywhere_before(self):
        self.assertEqual(
            P.latest_and_previous({"2031-W10", "2031-W11"}, ["2031-W08", "2031-W10", "2031-W11", "2031-W12"]),
            ("2031-W11", "2031-W10"),
        )
