"""What the store keeper can see before the General Manager has approved anything.

The draft transfer a keeper issues against is only created at the moment of
approval (`spray_plan_approval._create_draft_se`), so until a GM acts there is
nothing on the Transfers page at all — 708 work orders sat in `Awaiting
Approval` on this site with zero draft Stock Entries between them. The keeper
had no way to see what was coming and no way to prepare stock for it.

These endpoints answer that, and only that: they read `Work Order Item`, they
write nothing, and they must never show a plan drawn from a store the caller
does not keep.
"""

import unittest

import frappe

from upande_scp.serverscripts.store import store_keeper_api as api

KEEPER = "brian.chumba@karenroses.com"
NOT_A_KEEPER = "christine.cheruiyot@karenroses.com"


class TestTheTotals(unittest.TestCase):
	"""`planned_totals` is pure — the arithmetic the strip shows, with no database."""

	def test_it_sums_one_chemical_across_plans(self):
		rows = [
			{"item_code": "A", "item_name": "Amisil", "required_qty": 0.4, "uom": "Kilogram"},
			{"item_code": "A", "item_name": "Amisil", "required_qty": 0.6, "uom": "Kilogram"},
		]
		totals = api.planned_totals(rows)
		self.assertEqual(len(totals), 1)
		self.assertAlmostEqual(totals[0]["total_qty"], 1.0)
		self.assertEqual(totals[0]["item_name"], "Amisil")

	def test_it_keeps_units_apart(self):
		"""A litre and a kilogram of the same code are not two of anything."""
		rows = [
			{"item_code": "A", "item_name": "A", "required_qty": 1, "uom": "Litre"},
			{"item_code": "A", "item_name": "A", "required_qty": 2, "uom": "Kilogram"},
		]
		totals = api.planned_totals(rows)
		self.assertEqual(len(totals), 2)
		self.assertEqual({t["uom"] for t in totals}, {"Litre", "Kilogram"})

	def test_the_biggest_demand_leads(self):
		rows = [
			{"item_code": "A", "item_name": "A", "required_qty": 1, "uom": "L"},
			{"item_code": "B", "item_name": "B", "required_qty": 9, "uom": "L"},
		]
		self.assertEqual([t["item_code"] for t in api.planned_totals(rows)], ["B", "A"])

	def test_nothing_planned_totals_nothing(self):
		self.assertEqual(api.planned_totals([]), [])

	def test_a_missing_quantity_is_zero_not_a_crash(self):
		rows = [{"item_code": "A", "item_name": "A", "required_qty": None, "uom": "L"}]
		self.assertAlmostEqual(api.planned_totals(rows)[0]["total_qty"], 0.0)


class TestWhatComesBack(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.resp = api.list_planned_transfers()

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")

	def test_every_row_is_a_plan_still_waiting_on_the_gm(self):
		"""The whole point of the banner: nothing here is approved yet."""
		names = [r["work_order"] for r in self.resp["rows"][:40]]
		if not names:
			self.skipTest("no plans awaiting approval on this site")
		states = frappe.db.sql(
			"""SELECT name, workflow_state, docstatus FROM `tabWork Order`
			   WHERE name IN %(names)s""",
			{"names": tuple(names)},
			as_dict=True,
		)
		for s in states:
			self.assertEqual(s["workflow_state"], "Awaiting Approval", s["name"])
			self.assertEqual(s["docstatus"], 1, s["name"])

	def test_an_approved_plan_never_appears(self):
		approved = frappe.db.get_value(
			"Work Order",
			{"custom_type": "Application Floor Plan", "docstatus": 1, "workflow_state": "Approved"},
			"name",
		)
		if not approved:
			self.skipTest("no approved plans on this site")
		self.assertNotIn(approved, [r["work_order"] for r in self.resp["rows"]])

	def test_a_row_carries_what_the_table_shows(self):
		if not self.resp["rows"]:
			self.skipTest("no plans awaiting approval on this site")
		row = self.resp["rows"][0]
		for key in ("work_order", "planned_date", "greenhouse", "farm", "item_count", "total_qty"):
			self.assertIn(key, row)
		self.assertGreater(row["item_count"], 0, "a plan with no chemicals is not worth listing")

	def test_the_strip_and_the_rows_describe_the_same_work(self):
		"""The strip groups by chemical and the table groups by plan. They are two
		views of one set of lines, so their quantities must come to the same
		number — a keeper who reads the strip and then counts the rows must not
		find a discrepancy."""
		if not self.resp["rows"]:
			self.skipTest("no plans awaiting approval on this site")
		by_rows = sum(r["total_qty"] for r in self.resp["rows"])
		by_totals = sum(t["total_qty"] for t in self.resp["totals"])
		self.assertAlmostEqual(by_rows, by_totals, places=3)

	def test_the_farm_list_matches_the_farms_in_the_rows(self):
		self.assertEqual(
			set(self.resp["farms"]),
			{r["farm"] for r in self.resp["rows"] if r["farm"]},
		)


class TestNarrowingTheList(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_a_farm_filter_returns_only_that_farm(self):
		everything = api.list_planned_transfers()
		if not everything["farms"]:
			self.skipTest("no farms in the pending list")
		farm = everything["farms"][0]
		only = api.list_planned_transfers(farm=farm)
		self.assertTrue(only["rows"], "filtering to a farm that was listed returned nothing")
		self.assertEqual({r["farm"] for r in only["rows"]}, {farm})

	def test_a_date_window_cannot_widen_the_list(self):
		everything = api.list_planned_transfers()
		windowed = api.list_planned_transfers(from_date="2099-01-01")
		self.assertLessEqual(len(windowed["rows"]), len(everything["rows"]))
		self.assertEqual(windowed["rows"], [], "nothing is planned for 2099")


class TestItsOnlyEverAView(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_a_scout_is_refused(self):
		"""The sidebar hides the page; a curl call must still be turned away."""
		if not frappe.db.exists("User", NOT_A_KEEPER):
			self.skipTest("no non-keeper user to test with")
		frappe.set_user(NOT_A_KEEPER)
		try:
			with self.assertRaises(frappe.PermissionError):
				api.list_planned_transfers()
			with self.assertRaises(frappe.PermissionError):
				api.get_planned_items("MFG-WO-2025-00200")
		finally:
			frappe.set_user("Administrator")

	def test_a_keeper_sees_only_plans_drawn_from_stores_they_keep(self):
		if not frappe.db.exists("User", KEEPER):
			self.skipTest("no store keeper to test with")
		frappe.set_user(KEEPER)
		try:
			stores = api.allowed_stores_for(KEEPER)
			self.assertIsNotNone(stores, "this test needs a non-elevated keeper")
			resp = api.list_planned_transfers()
			for row in resp["rows"][:40]:
				drawn = frappe.db.sql(
					"""SELECT DISTINCT source_warehouse FROM `tabWork Order Item`
					   WHERE parent = %(wo)s AND IFNULL(source_warehouse,'') != ''""",
					{"wo": row["work_order"]},
					pluck="source_warehouse",
				)
				self.assertTrue(
					set(drawn) & set(stores),
					f"{row['work_order']} is drawn from {drawn}, none of which this keeper holds",
				)
		finally:
			frappe.set_user("Administrator")


class TestOnePlansChemicals(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_it_returns_the_planned_quantities(self):
		resp = api.list_planned_transfers()
		if not resp["rows"]:
			self.skipTest("no plans awaiting approval on this site")
		wo = resp["rows"][0]["work_order"]
		items = api.get_planned_items(wo)["items"]
		self.assertEqual(len(items), resp["rows"][0]["item_count"])
		for it in items:
			for key in ("item_code", "item_name", "qty", "uom", "from_warehouse"):
				self.assertIn(key, it)

	def test_an_unknown_plan_is_empty_rather_than_an_error(self):
		self.assertEqual(api.get_planned_items("MFG-WO-does-not-exist")["items"], [])
		self.assertEqual(api.get_planned_items("")["items"], [])

	def test_it_refuses_a_plan_the_gm_has_already_approved(self):
		"""This view is for pending work only — an approved plan belongs to the
		transfer list, where it can actually be issued."""
		approved = frappe.db.get_value(
			"Work Order",
			{"custom_type": "Application Floor Plan", "docstatus": 1, "workflow_state": "Approved"},
			"name",
		)
		if not approved:
			self.skipTest("no approved plans on this site")
		self.assertEqual(api.get_planned_items(approved)["items"], [])
