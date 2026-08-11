"""Trends aggregator — incidence denominator, ISO-week buckets, pest intensity.

The percentage this page plots used to divide affected units by every unit that
*exists* (``unitTotalsByStation``), which made it ``incidence × coverage``: it
understated by 2–2.5× and moved with scouting effort. These tests pin the
corrected model down — most importantly the ``affected ⊆ scouted`` invariant,
which the old model could not even express.

``_aggregate`` is pure apart from one farms-map lookup, which is patched.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_dashboard_aggregates_trends
"""

import unittest
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import patch

# NOTE: `dashboard_aggregates/__init__.py` does `from ._trends import trends as
# _trends`, which binds the *function* to the name `_trends` on the package and
# shadows this submodule. `from ... import _trends` therefore hands back the
# function, so load the module by path instead.
_trends = import_module("upande_scp.serverscripts.dashboard_aggregates._trends")

FARMS = {"Karen Farm": ["GH 12", "GH 13"]}


def obs_row(date, gh, zone, kind, name, stage="", count=0, entry=None):
    """One observation child row as _fetch_observations returns it."""
    return SimpleNamespace(
        name=entry or f"SE-{gh}-{zone}-{date}",
        date_of_capture=date,
        greenhouse=gh,
        block="",
        bed="",
        zone=zone,
        tree="",
        kind=kind,
        obs_name=name,
        stage=stage,
        obs_count=count,
    )


def scouted_row(date, gh, zone):
    """One Scouting Entry as _fetch_scouted returns it (no child join)."""
    return SimpleNamespace(
        date_of_capture=date,
        greenhouse=gh,
        block="",
        bed="",
        zone=zone,
        tree="",
    )


def aggregate(rows, scouted_rows):
    with patch.object(
        _trends.scouting_metrics, "get_farms_and_warehouses", return_value=FARMS
    ):
        return _trends._aggregate(rows, scouted_rows)


class TestWeekKey(unittest.TestCase):
    def test_iso_week_label_is_zero_padded_and_sortable(self):
        week_key = _trends.week_key
        self.assertEqual(week_key("2026-07-13"), "2026-W29")
        self.assertEqual(week_key("2026-01-05"), "2026-W02")
        # Zero-padding matters: plain string sort must be chronological.
        self.assertLess(week_key("2026-01-05"), week_key("2026-07-13"))

    def test_iso_year_boundary_rolls_into_the_owning_year(self):
        week_key = _trends.week_key
        # 2025-12-29 is a Monday and belongs to ISO week 1 of 2026.
        self.assertEqual(week_key("2025-12-29"), "2026-W01")

    def test_accepts_date_objects_and_rejects_junk(self):
        import datetime
        week_key = _trends.week_key
        self.assertEqual(week_key(datetime.date(2026, 7, 13)), "2026-W29")
        self.assertEqual(week_key(datetime.datetime(2026, 7, 13, 9, 30)), "2026-W29")
        self.assertEqual(week_key(None), "")
        self.assertEqual(week_key("not-a-date"), "")


class TestScoutedDenominator(unittest.TestCase):
    def test_clean_units_count_toward_the_sample_size(self):
        """The whole point of the fix: 5 zones scouted, only 2 with a pest.

        The observation rows can only ever see the 2. Incidence must be 2/5,
        not 2/(every zone in the greenhouse).
        """
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips", count=3),
            obs_row("2026-07-13", "GH 12", "Z2", "pest", "Thrips", count=1),
        ]
        scouted = [scouted_row("2026-07-13", "GH 12", f"Z{i}") for i in range(1, 6)]

        p = aggregate(rows, scouted)
        self.assertEqual(p["vocab"]["weeks"], ["2026-W29"])
        # scoutedByStation rows are [weekIdx, stationIdx, n]
        self.assertEqual(p["scoutedByStation"], [[0, 0, 5]])
        # byKindName rows are [weekIdx, stationIdx, obsIdx, n]
        self.assertEqual(p["byKindName"], [[0, 0, 0, 2]])

    def test_repeat_visits_collapse_to_distinct_units(self):
        """A zone scouted 3 times in a week is one unit, not three — 35% of
        zone-days on this site have more than one visit."""
        scouted = [
            scouted_row("2026-07-13", "GH 12", "Z1"),
            scouted_row("2026-07-14", "GH 12", "Z1"),
            scouted_row("2026-07-15", "GH 12", "Z1"),
            scouted_row("2026-07-15", "GH 12", "Z2"),
        ]
        p = aggregate([], scouted)
        self.assertEqual(p["scoutedByStation"], [[0, 0, 2]])

    def test_station_scouted_with_no_observations_still_has_a_denominator(self):
        """A clean greenhouse is real information — 0% incidence, not a gap.
        The old model dropped the station from the payload entirely."""
        p = aggregate([], [scouted_row("2026-07-13", "GH 12", "Z1")])
        self.assertEqual(p["vocab"]["stations"], ["GH 12"])
        self.assertEqual(p["scoutedByStation"], [[0, 0, 1]])
        self.assertEqual(p["byKindName"], [])

    def test_affected_is_a_subset_of_scouted_so_incidence_cannot_exceed_100(self):
        """The invariant the old denominator made unstateable. Every observation
        row hangs off an entry, so its unit must appear in the scouted set."""
        rows, scouted = [], []
        for i in range(1, 8):
            zone = f"Z{i}"
            scouted.append(scouted_row("2026-07-13", "GH 12", zone))
            # Two visits, two pests, several stages — plenty of chances to
            # double-count if the numerator weren't a distinct-unit count.
            for visit in range(2):
                for pest in ("Thrips", "Spider Mite"):
                    rows.append(
                        obs_row("2026-07-13", "GH 12", zone, "pest", pest,
                                stage="Adult", count=2,
                                entry=f"SE-{zone}-v{visit}")
                    )

        p = aggregate(rows, scouted)
        scouted_by_cell = {(w, s): n for w, s, n in p["scoutedByStation"]}
        for w, s, _o, n in p["byKindName"]:
            self.assertLessEqual(
                n, scouted_by_cell[(w, s)],
                "affected units exceeded scouted units — incidence would be >100%",
            )
        for row in p["byKindNameStage"]:
            w, s, _o, _g, n = row
            self.assertLessEqual(n, scouted_by_cell[(w, s)])
        for w, s, n in p["byAny"]:
            self.assertLessEqual(n, scouted_by_cell[(w, s)])


class TestWeekBuckets(unittest.TestCase):
    def test_days_in_one_iso_week_merge_into_a_single_bucket(self):
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips", count=1),
            obs_row("2026-07-15", "GH 12", "Z2", "pest", "Thrips", count=1),
        ]
        scouted = [
            scouted_row("2026-07-13", "GH 12", "Z1"),
            scouted_row("2026-07-15", "GH 12", "Z2"),
        ]
        p = aggregate(rows, scouted)
        self.assertEqual(p["allWeeks"], ["2026-W29"])
        self.assertEqual(p["byKindName"], [[0, 0, 0, 2]])

    def test_separate_weeks_stay_separate(self):
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips", count=1),
            obs_row("2026-07-21", "GH 12", "Z1", "pest", "Thrips", count=1),
        ]
        scouted = [
            scouted_row("2026-07-13", "GH 12", "Z1"),
            scouted_row("2026-07-21", "GH 12", "Z1"),
        ]
        p = aggregate(rows, scouted)
        self.assertEqual(p["allWeeks"], ["2026-W29", "2026-W30"])
        self.assertEqual(p["byKindName"], [[0, 0, 0, 1], [1, 0, 0, 1]])


class TestIntensity(unittest.TestCase):
    def test_repeat_visits_of_one_unit_average_rather_than_add(self):
        """Z1 visited twice with counts 2 and 6 → unit value 4, not 8.
        Matches the distinct-unit treatment of the denominator."""
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips",
                    count=2, entry="SE-A"),
            obs_row("2026-07-14", "GH 12", "Z1", "pest", "Thrips",
                    count=6, entry="SE-B"),
        ]
        scouted = [scouted_row("2026-07-13", "GH 12", "Z1")]
        p = aggregate(rows, scouted)
        # rows are [weekIdx, stationIdx, obsIdx, sum_of_per_unit_means]
        self.assertEqual(p["intensityByStation"], [[0, 0, 0, 4.0]])

    def test_counts_on_one_entry_sum_across_plant_sections(self):
        """Several rows on the SAME entry (different plant sections) are one
        visit, so their counts add before the per-unit mean."""
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips",
                    count=2, entry="SE-A"),
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips",
                    count=3, entry="SE-A"),
        ]
        p = aggregate(rows, [scouted_row("2026-07-13", "GH 12", "Z1")])
        self.assertEqual(p["intensityByStation"], [[0, 0, 0, 5.0]])

    def test_intensity_sums_across_units(self):
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips",
                    count=4, entry="SE-A"),
            obs_row("2026-07-13", "GH 12", "Z2", "pest", "Thrips",
                    count=6, entry="SE-B"),
        ]
        scouted = [
            scouted_row("2026-07-13", "GH 12", "Z1"),
            scouted_row("2026-07-13", "GH 12", "Z2"),
        ]
        p = aggregate(rows, scouted)
        self.assertEqual(p["intensityByStation"], [[0, 0, 0, 10.0]])

    def test_pressure_decomposes_into_incidence_times_severity(self):
        """The identity that justifies publishing both:
             pressure = (incidence/100) × severity
        Z1..Z2 affected out of 4 scouted, counts 4 and 6."""
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "pest", "Thrips",
                    count=4, entry="SE-A"),
            obs_row("2026-07-13", "GH 12", "Z2", "pest", "Thrips",
                    count=6, entry="SE-B"),
        ]
        scouted = [scouted_row("2026-07-13", "GH 12", f"Z{i}") for i in range(1, 5)]
        p = aggregate(rows, scouted)

        n = p["scoutedByStation"][0][2]              # 4 scouted
        k = p["byKindName"][0][3]                    # 2 affected
        sum_c = p["intensityByStation"][0][3]        # 10.0

        incidence = 100.0 * k / n                    # 50%
        severity = sum_c / k                         # 5.0 where present
        pressure = sum_c / n                         # 2.5 per scouted zone

        self.assertEqual(incidence, 50.0)
        self.assertEqual(severity, 5.0)
        self.assertEqual(pressure, 2.5)
        self.assertAlmostEqual(pressure, (incidence / 100.0) * severity)

    def test_diseases_are_excluded_from_intensity(self):
        """Diseases Scouting Entry has no count column, so a disease must not
        contribute a 0-valued intensity row that would drag a mean down."""
        rows = [
            obs_row("2026-07-13", "GH 12", "Z1", "disease", "Powdery Mildew",
                    stage="Fresh"),
        ]
        p = aggregate(rows, [scouted_row("2026-07-13", "GH 12", "Z1")])
        self.assertEqual(p["intensityByStation"], [])
        # ...but the disease still counts for incidence.
        self.assertEqual(p["byKindName"], [[0, 0, 0, 1]])


class TestSprayEventFold(unittest.TestCase):
    """The overlay reads Work Order Item, not the BOM: all 3,366 greenhouse work
    orders reference a BOM, but only 3 of 2,230 distinct BOMs carry any
    explosion items, so the BOM route yields 1 chemical instead of 54."""

    def rows(self):
        # One work order, two chemicals, one with two active ingredients — the
        # join fans out to four rows that must fold back into ONE event.
        return [
            SimpleNamespace(wo="WO-1", station="GH 12", planned="2026-07-13",
                            spray_type="Full", targets="Thrips\nBotrytis",
                            chemical="MOSPILAN", ingredient="acetamiprid"),
            SimpleNamespace(wo="WO-1", station="GH 12", planned="2026-07-13",
                            spray_type="Full", targets="Thrips\nBotrytis",
                            chemical="Tepeki", ingredient="flonicamid"),
            SimpleNamespace(wo="WO-1", station="GH 12", planned="2026-07-13",
                            spray_type="Full", targets="Thrips\nBotrytis",
                            chemical="Tepeki", ingredient="acetamiprid"),
            SimpleNamespace(wo="WO-2", station="GH 12", planned="2026-07-14",
                            spray_type="Top", targets="",
                            chemical="Amisil", ingredient=None),
        ]

    def fold(self):
        with patch.object(_trends.frappe.db, "sql", return_value=self.rows()):
            return _trends._fetch_spray_events("2026-07-06", "2026-07-19", ["GH 12"])

    def test_fanned_out_join_rows_fold_into_one_event_per_work_order(self):
        out = self.fold()
        self.assertEqual(list(out), ["2026-W29|GH 12"])
        self.assertEqual(len(out["2026-W29|GH 12"]), 2)

    def test_chemicals_and_ingredients_dedupe_and_sort(self):
        e = self.fold()["2026-W29|GH 12"][0]
        self.assertEqual(e["chemicals"], ["MOSPILAN", "Tepeki"])
        self.assertEqual(e["ingredients"], ["acetamiprid", "flonicamid"])

    def test_newline_separated_targets_split(self):
        e = self.fold()["2026-W29|GH 12"][0]
        self.assertEqual(e["targets"], ["Botrytis", "Thrips"])

    def test_missing_active_ingredient_yields_an_empty_list_not_a_null(self):
        # ~18% of real events have no recorded AI; the client renders
        # "AI not recorded" and must not crash on None.
        e = self.fold()["2026-W29|GH 12"][1]
        self.assertEqual(e["ingredients"], [])
        self.assertEqual(e["chemicals"], ["Amisil"])
        self.assertEqual(e["targets"], [])

    def test_events_are_ordered_by_date(self):
        dates = [e["date"] for e in self.fold()["2026-W29|GH 12"]]
        self.assertEqual(dates, sorted(dates))

    def test_no_stations_short_circuits(self):
        self.assertEqual(_trends._fetch_spray_events("2026-07-06", "2026-07-19", []), {})
