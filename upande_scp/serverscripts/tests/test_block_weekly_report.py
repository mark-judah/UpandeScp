"""The weekly block sheet for avocado and coffee."""

import io
import unittest

import frappe

from upande_scp.serverscripts.reports import block_weekly_report as R
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import thresholds_fixture as TF

PEST = "Fruit fly (Ceratitis)"


class TestAvailability(unittest.TestCase):
	def test_avocado_is_ready_because_lokitela_has_blocks(self):
		frappe.set_user("Administrator")
		a = R.availability("Avocado")
		farms = [r["farm"] for r in a["ready"]]
		self.assertIn("Lokitela", farms)

	def test_coffee_is_blocked_and_says_why(self):
		"""Endebess and Saboti are tagged for coffee but have no warehouse typed as a
		block, so a download would be blank for a reason that looks like a clean week."""
		frappe.set_user("Administrator")
		a = R.availability("Coffee")
		self.assertEqual(a["ready"], [])
		blocked = {r["farm"]: r["reason"] for r in a["blocked"]}
		self.assertIn("Endebess", blocked)
		self.assertIn("Saboti", blocked)
		self.assertIn("no blocks", blocked["Endebess"].lower())

	def test_a_farm_with_no_blocks_refuses_to_build(self):
		frappe.set_user("Administrator")
		with self.assertRaises(frappe.ValidationError):
			R.build_workbook_bytes("Coffee", "Endebess", 2026, 28)


# Header on row 6 (an explanatory line sits above it). Block, Area (ha) and
# Count / ha lead; the pests start at column 4 since thresholds piece 3a kept
# count per hectare as a column (D8).
HEADER_ROW = 6
FIRST_BLOCK_ROW = HEADER_ROW + 1
FIRST_PEST_COL = 4


class TestTheSheet(unittest.TestCase):
	YEAR, WEEK = 2026, 28

	def _sheet(self):
		from openpyxl import load_workbook

		frappe.set_user("Administrator")
		data = R.build_workbook_bytes("Avocado", "Lokitela", self.YEAR, self.WEEK)
		return load_workbook(io.BytesIO(data)).active

	def test_every_block_gets_a_row_even_with_no_findings(self):
		"""A block walked and found clean, and a block nobody visited, are different
		facts. Omitting both makes them identical."""
		ws = self._sheet()
		blocks = R._blocks_for_farm("Lokitela")
		self.assertTrue(blocks)
		names = set()
		for r in range(FIRST_BLOCK_ROW, ws.max_row):
			v = ws.cell(row=r, column=1).value
			if v:
				names.add(v)
		for b in blocks:
			self.assertIn(b, names)

	def test_pests_are_columns_and_cells_are_counts(self):
		ws = self._sheet()
		header = []
		for c in range(1, ws.max_column + 1):
			header.append(ws.cell(row=HEADER_ROW, column=c).value)
		self.assertEqual(header[0], "Block")
		# Area sits beside the block because it is the denominator every shaded
		# cell on that row was judged against.
		self.assertEqual(header[1], "Area (ha)")
		self.assertEqual(header[2], "Count / ha")
		pest_header = [h for h in header[FIRST_PEST_COL - 1 :] if h]
		self.assertEqual(pest_header[-1], "Total")
		self.assertGreater(len(pest_header), 1, "expected at least one pest column")

	def test_the_totals_row_adds_up(self):
		ws = self._sheet()
		# The legend and any missing-area note sit below the totals now, so the
		# totals row is no longer the last row on the sheet — find it by name.
		total_row = None
		for r in range(FIRST_BLOCK_ROW, ws.max_row + 1):
			if ws.cell(row=r, column=1).value == "Total":
				total_row = r
				break
		self.assertIsNotNone(total_row, "no Total row on the sheet")
		# Column totals must equal the sum of the block rows above them.
		for c in range(FIRST_PEST_COL, ws.max_column):
			column_sum = 0.0
			for r in range(FIRST_BLOCK_ROW, total_row):
				column_sum += float(ws.cell(row=r, column=c).value or 0)
			self.assertAlmostEqual(
				float(ws.cell(row=total_row, column=c).value or 0), column_sum
			)

	def test_the_week_is_named_in_the_sheet(self):
		ws = self._sheet()
		self.assertIn(f"{self.YEAR}-W{self.WEEK:02d}", str(ws["A2"].value))


class TestWeeks(unittest.TestCase):
	def test_only_weeks_with_scouting_are_offered(self):
		frappe.set_user("Administrator")
		weeks = R.report_weeks("Avocado", "Lokitela")
		self.assertTrue(weeks)
		for w in weeks:
			self.assertGreater(w["entries"], 0)

	def test_a_farm_with_no_blocks_offers_no_weeks(self):
		frappe.set_user("Administrator")
		self.assertEqual(R.report_weeks("Coffee", "Endebess"), [])


class TestBlocksReachThePlanner(unittest.TestCase):
	"""Blocks have to be offered to the planner, and with their area.

	`_resolve_user_scope` splits warehouses into `greenhouses` by type, and the
	bootstrap then runs those through `is_greenhouse_allowed` — a filter that enforces
	the `GH <N>` naming convention and the tunnel/phase/ipm/csu exclusions. Every one
	of those rules rejects `AIRSTRIP BLK 10 - KL`, so blocks need their own path.
	"""

	def test_blocks_carry_their_area(self):
		from upande_scp.serverscripts.spray_plan_creator.bootstrap import _enrich_blocks

		frappe.set_user("Administrator")
		raw = frappe.get_all(
			"Warehouse",
			filters={"custom_farm": "Lokitela", "warehouse_type": "Block", "disabled": 0},
			fields=["name", "custom_farm", "warehouse_type"],
		)
		if not raw:
			self.skipTest("no blocks on Lokitela")
		blocks = _enrich_blocks(raw)
		self.assertEqual(len(blocks), len(raw))
		with_area = [b for b in blocks if b["area_ha"] > 0]
		self.assertTrue(with_area, "no block carried an area — quantities cannot derive")
		for b in blocks:
			self.assertIn("custom_farm", b)
			self.assertIn("cost_center", b)

	def test_the_rose_area_source_is_empty_for_avocado(self):
		"""Why blocks need `custom_area_ha` at all: summing units the rose way is zero."""
		frappe.set_user("Administrator")
		total = frappe.db.sql(
			"""SELECT IFNULL(SUM(b.bed__area), 0) FROM `tabBed` b
			   JOIN `tabWarehouse` w ON w.name = b.greenhouse
			   WHERE w.custom_farm = 'Lokitela'"""
		)[0][0]
		self.assertEqual(float(total or 0), 0.0)


class TestPerHectare(unittest.TestCase):
	"""Count per hectare stays a column (thresholds D8). Pure logic."""

	def test_divides_the_weeks_total_by_the_blocks_area(self):
		self.assertEqual(R._per_hectare(30, 3.0), 10.0)
		self.assertEqual(R._per_hectare(30, 30.0), 1.0)

	def test_no_area_is_not_a_zero_area(self):
		"""Dividing by a missing denominator would invent a figure."""
		self.assertIsNone(R._per_hectare(30, None))
		self.assertIsNone(R._per_hectare(30, 0))


class TestShadingFollowsTheFigure(unittest.TestCase):
	"""The sheet shades with the alerts' figure and bands (D8). DB, rolled back;
	2031-W20 holds only what the test seeds."""

	def setUp(self):
		frappe.set_user("Administrator")
		self.block = F.avocado_block()
		TF.clear_all_bands("Avocado")

	def tearDown(self):
		frappe.set_user("Administrator")
		_common.clear_threshold_cache()
		frappe.db.rollback()

	def _seed(self):
		TF.seed_week(self.block, TF.WEEK_20[0], crop="Avocado", pest=PEST, stage="Adult", count=3, block=True)

	def _cell(self, pest):
		from openpyxl import load_workbook

		ws = load_workbook(io.BytesIO(R.build_workbook_bytes("Avocado", "Lokitela", 2031, 20))).active
		header = {ws.cell(row=HEADER_ROW, column=c).value: c for c in range(1, ws.max_column + 1)}
		row = next(r for r in range(FIRST_BLOCK_ROW, ws.max_row + 1) if ws.cell(row=r, column=1).value == self.block)
		return ws, row, ws.cell(row=row, column=header[pest])

	def test_a_count_row_shades_on_the_average_count_per_tree(self):
		TF.set_bands("Avocado", PEST, 0, 1, 2, measure="Count")
		self._seed()
		ws, row, cell = self._cell(PEST)
		self.assertEqual(cell.value, 27)                              # still the week's count: 9 trees x 3
		self.assertTrue(cell.fill.fgColor.rgb.endswith("F7B9B9"))     # 1.0 per tree -> Moderate
		area = frappe.db.get_value("Warehouse", self.block, "custom_area_ha")
		self.assertEqual(ws.cell(row=row, column=3).value, round(27 / float(area), 2))

	def test_a_percentage_row_shades_on_the_share_of_trees(self):
		TF.set_bands("Avocado", PEST, 0, 10, 30)
		self._seed()
		_ws, _row, cell = self._cell(PEST)
		self.assertTrue(cell.fill.fgColor.rgb.endswith("E98080"))     # 33.3 % -> High

	def test_misordered_bands_leave_the_cell_unshaded(self):
		TF.set_bands("Avocado", PEST, 1, 0.4, 2)
		self._seed()
		_ws, _row, cell = self._cell(PEST)
		self.assertNotEqual(cell.fill.fill_type, "solid")


class TestThresholdAndAreaLoading(unittest.TestCase):
	def test_blocks_without_an_area_are_absent_not_zero(self):
		"""`_block_areas` must omit them, so `_band` sees None and refuses to judge
		rather than dividing by nought."""
		frappe.set_user("Administrator")
		blocks = R._blocks_for_farm("Lokitela")
		areas = R._block_areas(blocks)
		self.assertTrue(areas, "Lokitela's blocks should carry custom_area_ha")
		self.assertTrue(all(v > 0 for v in areas.values()))
		self.assertTrue(set(areas).issubset(set(blocks)))

	def test_a_filter_with_all_bands_at_zero_is_not_a_threshold(self):
		"""Every avocado filter currently sits at 0/0/0. Returning those would paint
		every sighting red; they have to read as 'not set'."""
		frappe.set_user("Administrator")
		for spec in R._thresholds_for_crop("Avocado").values():
			self.assertTrue(
				(spec["low"] or spec["moderate"] or spec["high"]),
				"a threshold with nothing set should have been dropped",
			)
