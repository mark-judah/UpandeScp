"""Block groups: shares, the area split of a spray plan's expense posting, and
the plan-side validation. Nothing here is crop-specific — the posting tests use
COFFEE blocks (Saboti), the plan tests use whatever two blocks of a farm carry
an area and a cost centre.

Pure tests need no site data; the hook tests build an unsaved Stock Entry in
memory and mock the plan's block rows, so nothing is written.

Run: bench --site kaitet.local run-tests \
        --module upande_scp.serverscripts.tests.test_block_groups
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import flt

from upande_scp.serverscripts.spray_plan_creator import block_groups as BG


class TestShares(unittest.TestCase):
	def test_shares_are_area_over_total(self):
		self.assertEqual(BG.compute_shares([3, 1]), [0.75, 0.25])

	def test_a_block_without_area_is_refused(self):
		with self.assertRaises(ValueError):
			BG.compute_shares([2.0, 0])

	def test_largest_remainder_sums_exactly(self):
		for total in (1, 2, 7, 100, 999, 1000):
			for weights in ([1, 1, 1], [3.4, 2.84, 3.1], [0.01, 5, 0.5, 2]):
				parts = BG.largest_remainder(total, weights)
				self.assertEqual(sum(parts), total, (total, weights, parts))

	def test_ties_go_to_the_primary_block_first(self):
		self.assertEqual(BG.largest_remainder(1, [1, 1]), [1, 0])
		self.assertEqual(BG.largest_remainder(2, [1, 1, 1]), [1, 1, 0])


class TestSplitQty(unittest.TestCase):
	def test_fractional_split_sums_to_the_original(self):
		for qty, weights, p in (
			(1, [1, 1, 1], 3), (1, [3.4, 2.84, 3.1], 2), (12.345, [2.47, 7.528], 3),
			(0.75, [1, 2], 9),
		):
			parts, reason = BG.split_qty(qty, weights, p)
			self.assertIsNone(reason)
			self.assertEqual(flt(sum(parts), p), flt(qty, p), (qty, weights, parts))

	def test_thirds_at_two_decimals(self):
		parts, _ = BG.split_qty(1, [1, 1, 1], 2)
		self.assertEqual(parts, [0.34, 0.33, 0.33])

	def test_whole_number_uom_distributes_units(self):
		parts, reason = BG.split_qty(7, [3, 2, 2], 0, whole=True)
		self.assertIsNone(reason)
		self.assertEqual(parts, [3.0, 2.0, 2.0])
		self.assertTrue(all(p == int(p) for p in parts))

	def test_whole_number_too_few_units_falls_back(self):
		parts, reason = BG.split_qty(1, [1, 1, 1], 0, whole=True)
		self.assertIsNone(parts)
		self.assertIn("cannot be shared across 3 blocks", reason)

	def test_below_precision_falls_back(self):
		parts, reason = BG.split_qty(0.01, [1, 1, 1], 2)
		self.assertIsNone(parts)
		self.assertTrue(reason)


class TestPlanSplit(unittest.TestCase):
	BLOCKS = [{"cost_center": "A", "area_ha": 3}, {"cost_center": "B", "area_ha": 1}]

	def test_rows_of_one_key_are_pooled_then_split(self):
		rows = [
			{"key": "k", "qty": 0.5, "uom": "L", "cost_center": "A"},
			{"key": "k", "qty": 0.5, "uom": "L", "cost_center": "A"},
		]
		out = BG.plan_split(rows, self.BLOCKS, 3, set())
		self.assertEqual(out["k"], ([("A", 0.75), ("B", 0.25)], None))

	def test_unsplittable_stays_on_the_primary(self):
		rows = [{"key": "k", "qty": 1, "uom": "Nos", "cost_center": "Z"}]
		three = [
			{"cost_center": "A", "area_ha": 1}, {"cost_center": "B", "area_ha": 1},
			{"cost_center": "C", "area_ha": 1},
		]
		expected, reason = BG.plan_split(rows, three, 0, {"Nos"})["k"]
		self.assertEqual(expected, [("A", 1.0)])
		self.assertTrue(reason)

	def test_already_split_is_order_insensitive(self):
		self.assertTrue(BG.already_split([("B", 0.25), ("A", 0.75)], [("A", 0.75), ("B", 0.25)], 3))
		self.assertFalse(BG.already_split([("A", 1)], [("A", 0.75), ("B", 0.25)], 3))


# --- the Stock Entry hook (site needed for meta; nothing is saved) ------------

COFFEE_BLOCKS = [
	# Saboti is a coffee farm; areas mirror kaitet.local's SB1 / SB10.
	frappe._dict(block="SB10 - KL", area_ha=7.528, cost_center="SB10 - KL", share=0.752949),
	frappe._dict(block="SB1 - KL", area_ha=2.47, cost_center="SB1 - KL", share=0.247051),
]


def _issue(rows, plan="WO-TEST-BLOCKS"):
	se = frappe.new_doc("Stock Entry")
	se.purpose = "Material Issue"
	se.stock_entry_type = "Material Issue"
	se.custom_spray_plan = plan
	for item_code, qty, uom, cc in rows:
		se.append("items", {
			"item_code": item_code, "qty": qty, "uom": uom, "stock_uom": uom,
			"conversion_factor": 1, "s_warehouse": "SB10 - KL", "cost_center": cc,
			"expense_account": "Expense - KL",
		})
	return se


class TestStockEntryHook(unittest.TestCase):
	def run_hook(self, se, blocks=COFFEE_BLOCKS, whole=()):
		with mock.patch.object(BG, "_plan_blocks", return_value=list(blocks)), \
			mock.patch.object(BG, "_whole_uoms", return_value=set(whole)):
			BG.split_stock_entry(se)
		return [(r.item_code, r.cost_center, flt(r.qty, 9)) for r in se.items]

	def test_coffee_tank_mix_splits_by_area(self):
		se = _issue([("TANKMIX", 1, "Litre", "SB10 - KL")])
		out = self.run_hook(se)
		p = se.items[0].precision("qty")
		self.assertEqual([cc for _, cc, _ in out], ["SB10 - KL", "SB1 - KL"])
		self.assertEqual(flt(sum(q for *_, q in out), p), 1.0)
		self.assertAlmostEqual(out[0][2], 7.528 / 9.998, delta=10 ** -p)
		self.assertIn(BG.SPLIT_NOTE, se.remarks)
		self.assertEqual([r.idx for r in se.items], [1, 2])

	def test_idempotent(self):
		se = _issue([("TANKMIX", 1, "Litre", "SB10 - KL"), ("FOLIAR", 3, "Litre", "SB10 - KL")])
		first = self.run_hook(se)
		remarks = se.remarks
		second = self.run_hook(se)
		self.assertEqual(first, second)
		self.assertEqual(len(se.items), 4)
		self.assertEqual(se.remarks, remarks)

	def test_whole_number_uom_with_too_few_units_stays_on_primary(self):
		three = COFFEE_BLOCKS + [frappe._dict(block="SB2 - KL", area_ha=1, cost_center="SB2 - KL", share=0.1)]
		se = _issue([("TRAP", 1, "Nos", "WRONG")])
		out = self.run_hook(se, blocks=three, whole={"Nos"})
		self.assertEqual(out, [("TRAP", "SB10 - KL", 1.0)])
		self.assertIn("kept on SB10 - KL", se.remarks)

	def test_whole_number_uom_splits_whole_units(self):
		se = _issue([("TRAP", 5, "Nos", "SB10 - KL")])
		out = self.run_hook(se, whole={"Nos"})
		self.assertEqual(out, [("TRAP", "SB10 - KL", 4.0), ("TRAP", "SB1 - KL", 1.0)])

	def test_single_block_plan_is_a_no_op(self):
		se = _issue([("TANKMIX", 1, "Litre", "SB10 - KL")])
		out = self.run_hook(se, blocks=COFFEE_BLOCKS[:1])
		self.assertEqual(out, [("TANKMIX", "SB10 - KL", 1.0)])
		self.assertFalse(se.remarks)

	def test_unlinked_or_other_purposes_are_untouched(self):
		se = _issue([("TANKMIX", 1, "Litre", "SB10 - KL")], plan=None)
		self.assertEqual(self.run_hook(se), [("TANKMIX", "SB10 - KL", 1.0)])
		se = _issue([("TANKMIX", 1, "Litre", "SB10 - KL")])
		se.purpose = "Material Transfer"
		self.assertEqual(self.run_hook(se), [("TANKMIX", "SB10 - KL", 1.0)])


# --- plan side: real warehouses, read only ----------------------------------


def _two_blocks_of_a_farm():
	"""Two leaf warehouses of one farm with an area and a resolvable cost
	centre — coffee (Saboti) on kaitet.local; any farm elsewhere."""
	from upande_scp.serverscripts.spray_plan_creator.validation import match_cost_center

	rows = frappe.get_all(
		"Warehouse",
		filters={"custom_area_ha": (">", 0), "is_group": 0, "disabled": 0},
		fields=["name", "custom_farm", "custom_area_ha"],
		order_by="custom_farm, name",
	)
	by_farm: dict = {}
	for r in rows:
		if r.custom_farm and match_cost_center(r.name):
			by_farm.setdefault(r.custom_farm, []).append(r)
	for farm, blocks in by_farm.items():
		if len(blocks) >= 2:
			return farm, blocks[:2]
	return None, []


class TestPlanBlocks(unittest.TestCase):
	def setUp(self):
		self.farm, self.blocks = _two_blocks_of_a_farm()
		if not self.blocks:
			self.skipTest("no farm with two costed, measured blocks on this site")

	def test_rows_shares_and_primary_first(self):
		a, b = self.blocks
		rows = BG.build_block_rows([b.name, a.name], a.name, None)
		self.assertEqual(rows[0]["block"], a.name)
		self.assertAlmostEqual(sum(r["share"] for r in rows), 1.0, places=5)
		self.assertTrue(all(r["cost_center"] for r in rows))

	def test_largest_block_becomes_the_greenhouse(self):
		payload = {"custom_blocks": [b.name for b in self.blocks]}
		blocks = BG.normalise_payload_blocks(payload)
		largest = max(self.blocks, key=lambda r: r.custom_area_ha).name
		self.assertEqual(payload["custom_greenhouse"], largest)
		self.assertEqual(len(blocks), 2)

	def test_single_block_payload_stores_no_rows(self):
		payload = {"custom_blocks": [self.blocks[0].name], "custom_greenhouse": self.blocks[0].name}
		self.assertEqual(BG.normalise_payload_blocks(payload), [])

	def test_duplicates_and_foreign_greenhouse_refused(self):
		a, b = self.blocks
		with self.assertRaises(frappe.ValidationError):
			BG.normalise_payload_blocks({"custom_blocks": [a.name, a.name]})
		with self.assertRaises(frappe.ValidationError):
			BG.normalise_payload_blocks({"custom_blocks": [a.name, b.name], "custom_greenhouse": "Elsewhere"})

	def test_block_of_another_farm_refused(self):
		other = frappe.db.get_value(
			"Warehouse",
			{"custom_farm": ("not in", [self.farm, ""]), "is_group": 0, "custom_area_ha": (">", 0)},
			"name",
		)
		if not other:
			self.skipTest("no second farm with measured blocks")
		with self.assertRaises(frappe.ValidationError):
			BG.build_block_rows([self.blocks[0].name, other], self.blocks[0].name, None)

	def test_block_without_area_refused(self):
		a = self.blocks[0]
		no_area = frappe.db.get_value(
			"Warehouse",
			{"custom_farm": self.farm, "is_group": 0, "name": ("!=", a.name),
			 "custom_area_ha": ("in", [0, None])},
			"name",
		)
		if not no_area:
			self.skipTest("every block of this farm has an area")
		with self.assertRaises(frappe.ValidationError):
			BG.build_block_rows([a.name, no_area], a.name, None)
