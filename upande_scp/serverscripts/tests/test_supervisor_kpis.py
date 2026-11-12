"""Per-supervisor KPIs: plan facts, summaries, medians, radar. Pure — no database
rows are read or written (``frappe.flags.in_test`` only keeps imports quiet)."""
import unittest
from datetime import date, datetime

import frappe

frappe.flags.in_test = True

from upande_scp.serverscripts.sprayers import supervisor_kpis as K  # noqa: E402
from upande_scp.serverscripts.sprayers import supervisors as S  # noqa: E402

NOW = datetime(2026, 11, 12, 12, 0)


def plan(name, sched, start=None, **kw):
	base = {"name": name, "scheduled": sched, "start": start, "completed": False, "stopped": False,
	        "greenhouse": "GH " + name, "farm": "F1", "area": 1.0, "compliance": ""}
	base.update(kw)
	return base


def facts(p, **ctx):
	return K.plan_facts(p, ctx, NOW, S.classify)


class TestHelpers(unittest.TestCase):
	def test_median_even_odd_and_empty(self):
		self.assertEqual(K.median([3, 1, 2]), 2)
		self.assertEqual(K.median([1, 2, 3, 4]), 2.5)
		self.assertEqual(K.median([None, 5]), 5)
		self.assertIsNone(K.median([None]))

	def test_minutes_and_negative_guard(self):
		self.assertEqual(K.minutes_between("2026-11-03 09:00:00", "2026-11-03 09:45:00"), 45)
		self.assertIsNone(K.minutes_between(None, "2026-11-03 09:45:00"))
		self.assertIsNone(K._non_negative(-5))
		self.assertEqual(K._non_negative(0), 0)

	def test_late_grade_levels(self):
		sched = datetime(2026, 11, 3, 8, 0)  # cutoff 22:00 → 14 h window
		self.assertEqual(K.late_grade(sched, datetime(2026, 11, 3, 10, 30), "22:00:00"), "amber")
		self.assertEqual(K.late_grade(sched, datetime(2026, 11, 3, 16, 0), "22:00:00"), "orange")
		self.assertEqual(K.late_grade(sched, datetime(2026, 11, 3, 21, 0), "22:00:00"), "red")
		self.assertEqual(K.late_grade(sched, datetime(2026, 11, 3, 23, 0), "22:00:00"), "past_cutoff")


class TestPlanFacts(unittest.TestCase):
	def test_outcome_delay_and_grade(self):
		p = plan("A", datetime(2026, 11, 3, 8, 0), datetime(2026, 11, 3, 16, 0))
		f = facts(p)
		self.assertEqual((f["outcome"], f["grade"]), ("late", "orange"))
		self.assertEqual(f["delay_min"], 480)

	def test_pace_offline_and_sync(self):
		p = plan("A", datetime(2026, 11, 3, 8, 0), datetime(2026, 11, 3, 8, 30), completed=True)
		ctx = {
			"sessions": {"A": {"start": datetime(2026, 11, 3, 8, 30), "end": datetime(2026, 11, 3, 9, 15)}},
			"tokens": {"A": [{"status": "Synced", "mix_at": datetime(2026, 11, 3, 8, 10),
			                  "ended_at": datetime(2026, 11, 3, 9, 15),
			                  "synced_at": datetime(2026, 11, 3, 11, 15), "crew_warnings": "x"}]},
		}
		f = facts(p, **ctx)
		self.assertEqual(f["spray_min"], 45)
		self.assertEqual(f["mix_to_start_min"], 20)
		self.assertTrue(f["offline"])
		self.assertEqual(f["sync_min"], 120)
		self.assertEqual(f["crew_warnings"], 1)

	def test_quick_sync_is_online_and_back_dated_mix_dropped(self):
		p = plan("A", datetime(2026, 11, 3, 8, 0), datetime(2026, 11, 3, 8, 0))
		ctx = {"sessions": {"A": {"start": datetime(2026, 11, 3, 8, 0), "end": datetime(2026, 11, 3, 8, 30)}},
		       "tokens": {"A": [{"status": "Synced", "mix_at": datetime(2026, 11, 3, 9, 0),
		                         "ended_at": datetime(2026, 11, 3, 8, 30),
		                         "synced_at": datetime(2026, 11, 3, 8, 31)}]}}
		f = facts(p, **ctx)
		self.assertFalse(f["offline"])
		self.assertIsNone(f["mix_to_start_min"])

	def test_attendance_counts_only_when_someone_punched(self):
		p = plan("A", datetime(2026, 11, 3, 8, 0), datetime(2026, 11, 3, 8, 30))
		team = [{"employee": e, "role": "Sprayer"} for e in ("E1", "E2", "E3", "E4")]
		f = facts(p, team={"A": team}, checkins={("E1", date(2026, 11, 3)), ("E2", date(2026, 11, 3))})
		self.assertEqual((f["member_days"], f["absent"]), (4, 2))
		f = facts(p, team={"A": team}, checkins=set())
		self.assertEqual((f["member_days"], f["absent"]), (0, 0))

	def test_not_started_has_no_offline_flag(self):
		f = facts(plan("A", datetime(2026, 11, 3, 8, 0)))
		self.assertIsNone(f["offline"])
		self.assertEqual(f["outcome"], "never_started")


class TestSummary(unittest.TestCase):
	def build(self):
		a = facts(plan("A", datetime(2026, 11, 2, 8, 0), datetime(2026, 11, 2, 8, 20), completed=True, area=2),
		          sessions={"A": {"start": datetime(2026, 11, 2, 8, 20), "end": datetime(2026, 11, 2, 9, 0)}},
		          scans={"A": (2, 2)}, team={"A": [{"employee": "E1", "role": "Sprayer"}] * 2},
		          checkins={("E1", date(2026, 11, 2))}, postponements={"A": 1})
		b = facts(plan("B", datetime(2026, 11, 3, 8, 0), datetime(2026, 11, 3, 16, 0), completed=True, area=1,
		               compliance="Warnings"),
		          sessions={"B": {"start": datetime(2026, 11, 3, 16, 0), "end": datetime(2026, 11, 3, 17, 30)}},
		          scans={"B": (3, 1)}, refusals={"B": 2},
		          tokens={"B": [{"status": "Held — too short"}, {"status": "Partial"}]})
		c = facts(plan("C", datetime(2026, 11, 4, 8, 0)))
		d = facts(plan("D", datetime(2026, 11, 20, 8, 0)))  # still ahead: not due
		return [a, b, c, d]

	def test_numbers(self):
		k = K.summarise(self.build(), {"acted": 1, "by_other": 1, "nobody": 2})
		self.assertEqual((k["assigned"], k["completed"], k["completion_rate"]), (4, 2, 50.0))
		self.assertEqual((k["due"], k["on_time"], k["late"], k["never_started"]), (3, 1, 1, 1))
		self.assertEqual(k["on_time_pct"], 33.3)
		self.assertEqual(k["late_orange"], 1)
		self.assertEqual(k["median_start_delay_min"], 250)  # median of 20 and 480
		self.assertEqual(k["median_spray_min"], 65)         # median of 40 and 90
		self.assertEqual(k["accountability_pct"], 25.0)
		self.assertEqual((k["scan_plans"], k["scan_plans_complete"]), (3 - 1, 1))
		self.assertEqual(k["hectares"], 3.0)
		self.assertEqual(k["greenhouses_per_day"], 1.0)
		self.assertEqual((k["tokens_held"], k["tokens_partial"], k["tokens_refused"]), (1, 1, 0))
		self.assertEqual((k["postponements"], k["compliance_warnings"], k["refusals"]), (1, 1, 2))
		self.assertEqual((k["member_days"], k["absent_member_days"]), (2, 0))

	def test_weeks_and_events(self):
		fs = self.build()
		w = K.weeks_of(fs)
		self.assertEqual(sum(x["plans"] for x in w), 4)
		self.assertEqual(w[0]["week"], 202645)
		ev = K.events_of(fs, {"A": ["Ann"]})
		self.assertEqual(ev[0]["plan"], "D")  # newest first
		self.assertEqual([e for e in ev if e["plan"] == "A"][0]["acted_by"], ["Ann"])
		self.assertIn("postponed", [e for e in ev if e["plan"] == "A"][0]["flags"])


class TestRadarAndMedians(unittest.TestCase):
	def test_radar_normalisation(self):
		k = {"on_time_pct": 80, "completion_rate": 100, "accountability_pct": 50, "median_sync_min": 360,
		     "absence_rate": 10, "median_spray_min": 30}
		r = K.radar_of(k, pace_ref=60)
		self.assertEqual(r["punctuality"], 0.8)
		self.assertEqual(r["completion"], 1.0)
		self.assertAlmostEqual(r["sync"], 0.5)
		self.assertAlmostEqual(r["attendance"], 0.9)
		self.assertEqual(r["pace"], 1.0)  # twice as fast as the median
		self.assertEqual(K.radar_of({**k, "median_spray_min": 60}, 60)["pace"], 0.5)

	def test_radar_unknown_axes(self):
		r = K.radar_of({"on_time_pct": None, "completion_rate": 50}, None)
		self.assertIsNone(r["punctuality"])
		self.assertIsNone(r["sync"])
		self.assertIsNone(r["pace"])
		self.assertEqual(K.score_of(r), 50.0)

	def test_farm_medians(self):
		rows = [
			{"farm": "F1", "on_time_pct": 10, "radar": {a: 0.2 for a in K.RADAR_KEYS}},
			{"farm": "F1", "on_time_pct": 30, "radar": {a: 0.4 for a in K.RADAR_KEYS}},
			{"farm": "F1", "on_time_pct": 90, "radar": {a: None for a in K.RADAR_KEYS}},
			{"farm": "F2", "on_time_pct": 50, "radar": {a: 1.0 for a in K.RADAR_KEYS}},
		]
		m = {e["farm"]: e for e in K.farm_medians(rows)}
		self.assertEqual(m["F1"]["supervisors"], 3)
		self.assertEqual(m["F1"]["on_time_pct"], 30)
		self.assertEqual(m["F1"]["radar"]["punctuality"], 0.3)
		self.assertEqual(m["F2"]["radar"]["pace"], 1.0)

	def test_enrich_end_to_end(self):
		plans = [plan("A", datetime(2026, 11, 2, 8, 0), datetime(2026, 11, 2, 8, 20), completed=True),
		         plan("B", datetime(2026, 11, 3, 8, 0))]
		sup = {"A": ["S1"], "B": ["S1", "S2"]}
		scan = {"A": {"S1": datetime(2026, 11, 2, 8, 20)}}
		names = {"S1": "Sue", "S2": "Sam"}
		rows = S.build_rows(plans, sup, scan, NOW, names)
		out = S.enrich(rows, plans, sup, scan, {}, NOW, names)
		by = {r["employee"]: r for r in out["rows"]}
		self.assertEqual(by["S1"]["assigned"], 2)
		self.assertEqual(by["S1"]["on_time_pct"], 50.0)
		self.assertEqual(by["S2"]["assigned"], 1)
		self.assertEqual(by["S1"]["events"][0]["plan"], "B")
		self.assertEqual(by["S1"]["farm"], "F1")
		self.assertEqual(out["medians"][0]["supervisors"], 2)
		self.assertIn("radar", by["S2"])


if __name__ == "__main__":
	unittest.main()
