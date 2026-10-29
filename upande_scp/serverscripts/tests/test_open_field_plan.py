"""Open-field multi-block spray plan: the block directory, per-block findings
and the all-or-nothing batch of drafts. One draft Work Order per block, made by
the same `create_draft_spray_plan` the greenhouse plan uses.

Pure tests need no data; the batch tests mock the single-plan creator so no
Work Order, BOM or team is needed (Mutara has none yet). The directory tests
read the Mutara tree and skip where it is absent.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_open_field_plan
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_plan_creator import open_field as OF


WH = {
	"Mutara - MUT": {"parent_warehouse": None, "warehouse_type": None},
	"Pivot 1 - MUT": {"parent_warehouse": "Mutara - MUT", "warehouse_type": "Pivot"},
	"P1-B1 - MUT": {"parent_warehouse": "Pivot 1 - MUT", "warehouse_type": "Block"},
	"P1-B2 - MUT": {"parent_warehouse": "Pivot 1 - MUT", "warehouse_type": "Block"},
	"Phase 1 - MUT": {"parent_warehouse": "Mutara - MUT", "warehouse_type": "Phase"},
	"Section A - MUT": {"parent_warehouse": "Phase 1 - MUT", "warehouse_type": "Section"},
	"Avocado Block A - MUT": {"parent_warehouse": "Section A - MUT", "warehouse_type": "Block"},
	"Loose - MUT": {"parent_warehouse": "Mutara - MUT", "warehouse_type": "Block"},
}


class TestGrouping(unittest.TestCase):
	def test_group_is_the_nearest_pivot_or_section(self):
		self.assertEqual(OF.group_of("P1-B1 - MUT", WH), ("Pivot", "Pivot 1 - MUT"))
		self.assertEqual(OF.group_of("Avocado Block A - MUT", WH), ("Section", "Section A - MUT"))

	def test_a_block_with_neither_has_no_group(self):
		self.assertEqual(OF.group_of("Loose - MUT", WH), (None, None))

	def test_groups_keep_every_block_whatever_the_count(self):
		blocks = [{"name": f"P1-B{i} - MUT"} for i in range(1, 13)]
		wh = dict(WH)
		for b in blocks:
			wh[b["name"]] = {"parent_warehouse": "Pivot 1 - MUT", "warehouse_type": "Block"}
		groups = OF.build_groups(blocks, wh)
		self.assertEqual(len(groups), 1)
		self.assertEqual(len(groups[0]["blocks"]), 12)
		self.assertEqual(groups[0]["kind"], "Pivot")

	def test_groups_are_ordered_and_ungrouped_blocks_come_last(self):
		blocks = [{"name": n} for n in ("Loose - MUT", "P1-B2 - MUT", "Avocado Block A - MUT", "P1-B1 - MUT")]
		groups = OF.build_groups(blocks, WH)
		self.assertEqual([g["name"] for g in groups], ["Pivot 1 - MUT", "Section A - MUT", None])
		self.assertEqual([b["name"] for b in groups[0]["blocks"]], ["P1-B1 - MUT", "P1-B2 - MUT"])

	def test_natural_order_puts_b2_before_b10(self):
		self.assertEqual(sorted(["P1-B10 - MUT", "P1-B2 - MUT"], key=OF.natural_key),
		                 ["P1-B2 - MUT", "P1-B10 - MUT"])


class TestFindingsShape(unittest.TestCase):
	def test_rows_roll_up_per_block_and_kind(self):
		rows = [
			{"block": "A", "kind": "pest", "name": "Thrips", "count": 3, "last_seen": "2026-10-01"},
			{"block": "A", "kind": "pest", "name": "Thrips", "count": 2, "last_seen": "2026-10-05"},
			{"block": "A", "kind": "disease", "name": "Rust", "count": 1, "last_seen": "2026-10-02"},
			{"block": "B", "kind": "pest", "name": "Mites", "count": 4, "last_seen": "2026-10-03"},
		]
		out = OF.roll_up_findings(rows, ["A", "B", "C"])
		self.assertEqual(out["A"]["pests"], [{"name": "Thrips", "count": 5, "last_seen": "2026-10-05"}])
		self.assertEqual(out["A"]["diseases"][0]["name"], "Rust")
		self.assertEqual(out["C"], {"pests": [], "diseases": [], "targets": []})
		self.assertEqual(out["A"]["targets"], ["Thrips", "Rust"])


class TestBatchValidation(unittest.TestCase):
	def plan(self, block, **kw):
		p = {
			"custom_greenhouse": block,
			"custom_classification": "Curative",
			"custom_spray_team": "T1",
			"production_item": "BOM-1",
			"custom_water_volume": 1000,
			"chemicals": [{"item_code": "X", "application_rate": 1}],
		}
		p.update(kw)
		return p

	def test_a_complete_plan_has_no_problems(self):
		self.assertEqual(OF.plan_problems(self.plan("B1")), [])

	def test_missing_pieces_are_named(self):
		p = OF.plan_problems({"custom_greenhouse": "B1"})
		self.assertTrue(any("Preventive or Curative" in m for m in p))
		self.assertTrue(any("team" in m for m in p))
		self.assertTrue(any("tank mix" in m.lower() for m in p))
		self.assertTrue(any("chemical" in m for m in p))

	def test_a_roster_counts_as_a_team(self):
		p = self.plan("B1", custom_spray_team=None,
		              custom_spray_plan_team_members=[{"employee": "E1", "role": "Sprayer"}])
		self.assertEqual(OF.plan_problems(p), [])

	def test_preventive_needs_a_reason(self):
		p = self.plan("B1", custom_classification="Preventive")
		self.assertTrue(any("reason" in m for m in OF.plan_problems(p)))


class TestBatch(unittest.TestCase):
	def setUp(self):
		self.user = mock.patch.object(OF, "_require_creator", return_value="Administrator")
		self.user.start()

	def tearDown(self):
		self.user.stop()

	def good(self, block):
		return TestBatchValidation().plan(block)

	def test_each_block_gets_its_own_draft(self):
		with mock.patch.object(OF, "create_draft_spray_plan",
		                       side_effect=lambda payload: {"work_order": "WO-" + payload["custom_greenhouse"],
		                                                    "warnings": [], "compliance": None}) as m:
			out = OF.create_draft_plans_batch([self.good("B1"), self.good("B2")])
		self.assertEqual([r["work_order"] for r in out["results"]], ["WO-B1", "WO-B2"])
		self.assertEqual([r["block"] for r in out["results"]], ["B1", "B2"])
		self.assertEqual(m.call_count, 2)

	def test_an_incomplete_block_stops_the_whole_batch_before_anything_is_made(self):
		with mock.patch.object(OF, "create_draft_spray_plan") as m:
			with self.assertRaises(frappe.ValidationError) as cm:
				OF.create_draft_plans_batch([self.good("B1"), {"custom_greenhouse": "B2"}])
		self.assertIn("B2", str(cm.exception))
		m.assert_not_called()

	def test_a_failure_part_way_rolls_back_and_names_the_block(self):
		calls = []

		def fake(payload):
			calls.append(payload["custom_greenhouse"])
			if payload["custom_greenhouse"] == "B2":
				frappe.throw("No Cost Center named 'B2' exists")
			return {"work_order": "WO-" + payload["custom_greenhouse"], "warnings": [], "compliance": None}

		with mock.patch.object(OF, "create_draft_spray_plan", side_effect=fake), \
		     mock.patch.object(frappe.db, "savepoint") as sp, \
		     mock.patch.object(frappe.db, "rollback") as rb:
			with self.assertRaises(frappe.ValidationError) as cm:
				OF.create_draft_plans_batch([self.good("B1"), self.good("B2"), self.good("B3")])
		self.assertIn("B2", str(cm.exception))
		self.assertEqual(calls, ["B1", "B2"])
		sp.assert_called_once()
		rb.assert_called_once()

	def test_a_block_listed_twice_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			OF.create_draft_plans_batch([self.good("B1"), self.good("B1")])

	def test_an_empty_batch_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			OF.create_draft_plans_batch([])


class TestDirectory(unittest.TestCase):
	def setUp(self):
		if not frappe.db.exists("Warehouse", "P1-B1 - MUT"):
			self.skipTest("Mutara pivot blocks are not on this site")

	def test_pivot_blocks_are_grouped_with_cost_centre_and_crop_key(self):
		with mock.patch.object(OF, "_scope_blocks", return_value=[
			{"name": "P1-B1 - MUT", "custom_farm": "Mutara"},
			{"name": "Avocado Block A - MUT", "custom_farm": "Mutara"},
		]):
			out = OF.get_open_field_blocks()
		names = {g["name"]: g for g in out["groups"]}
		self.assertIn("Pivot 1 - MUT", names)
		b = names["Pivot 1 - MUT"]["blocks"][0]
		self.assertEqual(b["name"], "P1-B1 - MUT")
		self.assertEqual(b["label"], "P1-B1")
		self.assertEqual(b["cost_center"], "P1-B1 - MUT")
		self.assertIn("crop", b)
		self.assertIn("area_ha", b)
		self.assertEqual(out["groups"][0]["kind"], "Pivot")
