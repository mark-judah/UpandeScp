"""One-row-per-unit scouting summary for the block-grown maps.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_unit_summary
"""

import unittest

import frappe

from upande_scp.serverscripts.scouting import unit_summary as U


def row(triad=None, block="B1", lat="0.03", lng="36.68", d="2026-10-01", t="08:00:00", name="x", scout="S"):
	return {"name": name, "triad": triad, "block": block, "latitude": lat, "longitude": lng,
	        "date_of_capture": d, "time_of_capture": t, "scouts_name": scout}


class TestPure(unittest.TestCase):
	def test_unit_key(self):
		self.assertEqual(U.unit_key("T1", "B", None, None), "h:T1")
		self.assertEqual(U.unit_key(None, "B", "0.036557", "36.6836"), U.unit_key(None, "B", "0.036561", "36.68362"))
		self.assertNotEqual(U.unit_key(None, "B", "0.03", "36.6836"), U.unit_key(None, "B", "0.0312", "36.6836"))
		self.assertNotEqual(U.unit_key(None, "B", "0.0365", "36.6836"), U.unit_key(None, "B", "0.0375", "36.6836"))
		self.assertIsNone(U.unit_key(None, "B", "", ""))
		self.assertIsNone(U.unit_key(None, "B", "0", "0"))

	def test_latest_per_unit_keeps_newest_and_counts_visits(self):
		rows = [
			row("T1", d="2026-10-01", name="a", scout="old"),
			row("T1", d="2026-10-05", t="09:00:00", name="b", scout="new"),
			row("T1", d="2026-10-05", t="07:00:00", name="c", scout="mid"),
			row("T2", d="2026-09-01", name="d"),
			row(None, lat=None, lng=None, name="nowhere"),
		]
		out = U.latest_per_unit(rows)
		self.assertEqual([r["name"] for r in out], ["b", "d"])
		self.assertEqual([r["visits"] for r in out], [3, 1])
		self.assertEqual(out[0]["scouts_name"], "new")


	def test_encode_is_columnar(self):
		units = U.latest_per_unit([
			row("T1", name="a", scout="S1", d="2026-10-05"),
			row(None, name="b", scout="S2", lat="0.0365", lng="36.6836", d="2026-10-04"),
			row(None, name="c", scout="S1", block="B2", lat="0.04", lng="36.7", d="2026-10-03"),
		])
		e = U.encode(units)
		self.assertEqual(e["scouts"], ["S1", "S2"])
		self.assertEqual(e["blocks"], ["B1", "B2"])
		self.assertEqual(e["hex"], [["T1", 0, 0, 1, "2026-10-05"]])
		self.assertEqual(e["pts"], [[36683600, 36500, 1, 0, 1, "2026-10-04"], [36700000, 40000, 0, 1, 1, "2026-10-03"]])


class TestDb(unittest.TestCase):
	def setUp(self):
		if not frappe.db.exists("Scouting Entry", {"_user_tags": ["like", "%mutara-demo-scouting%"]}):
			self.skipTest("mutara demo scouting absent")

	def test_summary_is_far_smaller_than_the_raw_entries(self):
		frappe.set_user("Administrator")
		r = U.get_scouting_unit_summary("2026-08-29", "2026-10-29", "Avocado")
		self.assertTrue(r["aggregated"])
		self.assertGreater(r["total_entries"], 3000)
		self.assertLess(len(r["pts"]), r["total_entries"])
		self.assertEqual(r["hex"], [])

	def test_hexagon_crop_carries_triads_and_every_live_block(self):
		frappe.set_user("Administrator")
		r = U.get_scouting_unit_summary("2026-08-29", "2026-10-29", "Potato")
		self.assertTrue(r["aggregated"] and r["hex"])
		self.assertGreaterEqual(len(r["blocks"]), 8)

	def test_unscoped_keeps_the_raw_path(self):
		self.assertFalse(U.get_scouting_unit_summary("2026-08-29", "2026-10-29")["aggregated"])

	def test_entries_on_trees_keep_the_raw_path(self):
		frappe.set_user("Administrator")
		orig = frappe.db.sql

		def fake(q, *a, **k):
			return [(1,)] if "IFNULL(se.tree" in q else orig(q, *a, **k)

		frappe.db.sql = fake
		try:
			r = U._build("2026-08-29", "2026-10-29", "Avocado", None)
		finally:
			frappe.db.sql = orig
		self.assertEqual(r, {"aggregated": False, "total_entries": 0})
