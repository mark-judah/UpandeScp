"""Pure tests for the weekly spray records email, the supervisor KPI, zone
coverage and the avocado scout email. No database rows are read."""
import unittest
from datetime import date, datetime, timedelta

from upande_scp.serverscripts.reports import avocado_scout_email as A
from upande_scp.serverscripts.reports import spray_records_email as SR
from upande_scp.serverscripts.scouting import zone_coverage as Z
from upande_scp.serverscripts.sprayers import supervisors as S


class TestSprayRecords(unittest.TestCase):
	def test_send_day_and_week(self):
		self.assertTrue(SR.is_send_day("Monday", "2026-11-09"))
		self.assertFalse(SR.is_send_day("Tuesday", "2026-11-09"))
		self.assertTrue(SR.is_send_day("Nonsense", "2026-11-09"))  # falls back to Monday
		self.assertEqual(SR.last_week_monday("2026-11-11"), date(2026, 11, 2))

	LOOKUP = {
		"amisil": {"product": "SP1", "name": "Amisil", "ingredients": ["Sulphur"], "uom": "Litre"},
		"duo": {"product": "SP2", "name": "Duo", "ingredients": ["Abamectin", "Bifenthrin"], "uom": "Litre"},
		"plain": {"product": "SP3", "name": "Plain", "ingredients": [], "uom": "Kg"},
	}

	def apps(self):
		return [
			{"doc": "L1", "date": "2026-10-13", "farm": "F", "location": "GH1", "label": "Amisil", "qty": 1.5, "source": "Logsheet"},
			{"doc": "L2", "date": "2026-10-15", "farm": "F", "location": "GH1", "label": "Amisil", "qty": 2, "source": "Logsheet"},
			{"doc": "L2", "date": "2026-10-15", "farm": "F", "location": "GH1", "label": "Duo", "qty": 1, "source": "Logsheet"},
			{"doc": "W1", "date": "2026-10-14", "farm": None, "location": "GH2", "label": "plain", "qty": 4, "source": "Work order"},
			{"doc": "W1", "date": "2026-10-14", "farm": None, "location": "GH2", "label": "PACKAGING", "qty": 9, "source": "Work order"},
		]

	def test_grouping_quantity_and_last_date(self):
		out = SR.build_rows(self.apps(), self.LOOKUP, {"GH2": "F"})
		rows = {(r["location"], r["ingredient"], r["product"]): r for r in out["F"]["rows"]}
		a = rows[("GH1", "Sulphur", "Amisil")]
		self.assertEqual((a["applications"], a["quantity"], a["last"]), (2, 3.5, date(2026, 10, 15)))

	def test_multi_ai_listed_under_each_with_full_quantity(self):
		out = SR.build_rows(self.apps(), self.LOOKUP, {})
		rows = {(r["ingredient"], r["product"]): r for r in out["F"]["rows"]}
		self.assertEqual(rows[("Abamectin", "Duo")]["quantity"], 1)
		self.assertEqual(rows[("Bifenthrin", "Duo")]["quantity"], 1)
		self.assertEqual(rows[("Abamectin", "Duo")]["also"], ["Bifenthrin"])

	def test_unrecorded_ai_is_listed_and_unknown_plan_items_skipped(self):
		out = SR.build_rows(self.apps(), self.LOOKUP, {"GH2": "F"})
		self.assertEqual(out["F"]["unrecorded"], {"Plain": 1})
		self.assertTrue(any(r["ingredient"] == SR.NOT_RECORDED and r["product"] == "Plain" for r in out["F"]["rows"]))
		self.assertFalse(any(r["product"] == "PACKAGING" for r in out["F"]["rows"]))

	def test_farm_falls_back_to_the_warehouse(self):
		out = SR.build_rows(self.apps(), self.LOOKUP, {"GH2": "G"})
		self.assertIn("G", out)


class TestSupervisorKpi(unittest.TestCase):
	NOW = datetime(2026, 10, 20, 12, 0)

	def test_outcomes(self):
		sched = datetime(2026, 10, 15, 9, 0)
		c = lambda start, **k: S.classify(sched, start, self.NOW, **k)
		self.assertEqual(c(datetime(2026, 10, 15, 8, 0)), "on_time")        # early
		self.assertEqual(c(datetime(2026, 10, 15, 11, 0)), "on_time")       # exactly 2 h
		self.assertEqual(c(datetime(2026, 10, 15, 11, 1)), "late")
		self.assertEqual(c(datetime(2026, 10, 16, 8, 0)), "missed")         # next day
		self.assertEqual(c(None), "never_started")
		self.assertIsNone(c(None, stopped=True))
		self.assertIsNone(S.classify(datetime(2026, 10, 21, 9, 0), None, self.NOW))  # still ahead
		self.assertIsNone(S.classify(None, None, self.NOW))

	def plan(self, name, sched, start, completed=True):
		return {"name": name, "scheduled": sched, "start": start, "completed": completed, "stopped": False}

	def test_rows_count_assigned_acted_and_rank(self):
		d = datetime(2026, 10, 15, 9, 0)
		plans = [
			self.plan("P1", d, d),
			self.plan("P2", d, d + timedelta(hours=5)),
			self.plan("P3", d, None, completed=False),
			self.plan("P4", d, d),
		]
		sup = {"P1": ["A"], "P2": ["A"], "P3": ["A"], "P4": ["B"]}
		scan = {"P1": {"A": d}, "P2": {"C": d}, "P4": {"B": d}}
		rows = {r["employee"]: r for r in S.build_rows(plans, sup, scan, self.NOW, {"A": "Ann", "B": "Bo", "C": "Cy"})}
		a = rows["A"]
		self.assertEqual((a["assigned"], a["acted"], a["by_other"], a["nobody"]), (3, 1, 1, 1))
		self.assertEqual((a["on_time"], a["late"], a["never_started"], a["due"]), (1, 1, 1, 3))
		self.assertEqual(a["on_time_pct"], 33.3)
		self.assertEqual(rows["B"]["rank"], 1)          # 100 % on time
		self.assertEqual(a["rank"], 2)
		self.assertEqual(rows["C"]["covered_for_others"], 1)
		self.assertIsNone(rows["C"]["rank"])             # nothing assigned, not ranked

	def test_describe_names_both(self):
		acc = {"supervisors": [{"name": "Ann"}], "scanners": [], "nobody_scanned": True}
		self.assertEqual(S.describe(acc), "Ann; nobody scanned")
		acc = {"supervisors": [{"name": "Ann"}], "scanners": [{"name": "Cy"}], "nobody_scanned": False}
		self.assertEqual(S.describe(acc), "Ann; scanned by Cy")


class TestZoneCoverage(unittest.TestCase):
	UNI = {"H": {"zones": 10, "beds": {"H - Bed 1": 5, "H - Bed 2": 5}}}

	def test_full_is_strictly_above_80(self):
		self.assertEqual(Z.status_of(80.0, 5), "Partial")
		self.assertEqual(Z.status_of(80.1, 5), "Full")
		self.assertEqual(Z.status_of(None, 0), "Not scouted")

	def parts(self, zones_by_day):
		return {
			d: {"H": {"H - Bed 1": {z: 1 for z in zs}}} for d, zs in zones_by_day.items()
		}

	def test_week_row_counts_zones_beds_and_under(self):
		monday = date(2026, 10, 12)
		zs = [f"H - Bed 1 - Zone {i}" for i in range(1, 6)]
		parts = self.parts({"2026-10-12": zs[:3], "2026-10-13": zs[2:]})  # all 5 zones of bed 1, one overlap
		row = Z.week_rows(parts, self.UNI, ["H"], monday)[0]
		self.assertEqual(row["entries"], 6)
		self.assertEqual((row["zones_scouted"], row["zones_total"], row["zone_pct"]), (5, 10, 50.0))
		self.assertEqual(row["status"], "Partial")
		self.assertEqual((row["beds_scouted"], row["beds_total"]), (1, 2))
		self.assertEqual(row["entries_per_bed"], 6.0)
		self.assertEqual(row["beds_under"], 1)
		self.assertEqual(row["under"][0]["bed"], "Bed 2")      # never keyed: 0 %
		self.assertEqual(row["days"][0]["zones"], 3)

	def test_full_house_and_partial_bed_listed(self):
		uni = {"H": {"zones": 10, "beds": {"H - Bed 1": 5, "H - Bed 2": 5}}}
		parts = {"2026-10-12": {"H": {
			"H - Bed 1": {f"H - Bed 1 - Zone {i}": 1 for i in range(1, 6)},
			"H - Bed 2": {f"H - Bed 2 - Zone {i}": 1 for i in range(1, 5)},
		}}}
		row = Z.week_rows(parts, uni, ["H"], date(2026, 10, 12))[0]
		self.assertEqual(row["zone_pct"], 90.0)
		self.assertEqual(row["status"], "Full")
		self.assertEqual(row["beds_under"], 0)                  # 4/5 = 80 % is not under 80

	def test_unscouted_house(self):
		row = Z.week_rows({}, self.UNI, ["H"], date(2026, 10, 12))[0]
		self.assertEqual((row["status"], row["entries"], row["under"]), ("Not scouted", 0, []))

	def test_weeks_between(self):
		self.assertEqual(Z.weeks_between("2026-10-14", "2026-10-20"), [date(2026, 10, 12), date(2026, 10, 19)])


class TestAvocadoScout(unittest.TestCase):
	def test_walked_skips_jumps_and_gaps(self):
		a = (0.0, 36.0)
		b = (0.0009, 36.0)      # ~100 m
		far = (0.5, 36.0)       # ~55 km: a glitch
		self.assertAlmostEqual(A.walked_m([a, b]), 100, delta=2)
		self.assertAlmostEqual(A.walked_m([a, b, far, b]), 100, delta=2)   # both legs to/from the jump dropped
		self.assertAlmostEqual(A.walked_m([a, None, b]), 0, delta=0.1)      # a missing fix breaks the chain

	def entry(self, scout, n, day="2026-10-12"):
		return [
			{"scout": scout, "day": day, "time": f"10:{i % 60:02d}:00", "block": f"B{i % 3}", "tree": f"T{i}",
			 "lat": str(0.0 + i * 0.00001), "lon": "36.0"}
			for i in range(n)
		]

	def test_minimum_entries(self):
		listed, below = A.scout_rows(self.entry("S1", 25) + self.entry("S2", 19))
		self.assertEqual([r["scout"] for r in listed], ["S1"])
		self.assertEqual([(r["scout"], r["entries"]) for r in below], [("S2", 19)])
		r = listed[0]
		self.assertEqual((r["entries"], r["trees"], r["blocks"], r["days"]), (25, 25, 3, 1))
		self.assertGreater(r["km"], 0)
