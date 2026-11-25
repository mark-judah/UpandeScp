"""Regenerating a block's Row/hexagon grid as Hexa → Triad.

Each test builds its own `_Test` farm and block holding two old Rows of 3 m
hexagon "Triads" (inserted raw, the way the survey import left them), so nothing
touches the real Mutara blocks.

Run: bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_regenerate_hexa_grid
"""

import json
import math
import unittest

import frappe
from pyproj import Transformer
from shapely.geometry import Point, Polygon, box

from upande_scp.serverscripts.geo import regenerate_hexa_grid as R

TEST_FARM = "_Test Hexa Regen Farm"
TEST_BLOCK_LABEL = "_Test Hexa Regen BLK"
TEST_TRAP = "_Test Hexa Regen Trap"
TEST_TREE = "_Test Hexa Regen Tree"
OLD_LEVELS = ("Has Blocks", "Has Rows")
EPSG = "EPSG:32637"
ORIGIN = (36.70, 0.10)  # lng, lat — away from any real block


def _hexagons(width=30.0, height=20.0, r=1.5):
	"""Pointy-top 3 m hexagons (UTM) tiled over a width × height rectangle."""
	fwd = Transformer.from_crs("EPSG:4326", EPSG, always_xy=True)
	x0, y0 = fwd.transform(*ORIGIN)
	area = box(x0, y0, x0 + width, y0 + height)
	w, dy = math.sqrt(3) * r, 1.5 * r
	out = []
	for row in range(int(height / dy) + 2):
		for col in range(-1, int(width / w) + 2):
			cx = x0 + col * w + (w / 2 if row % 2 else 0)
			cy = y0 + height - row * dy
			hexagon = Polygon(
				[(cx + r * math.cos(math.radians(30 + 60 * k)), cy + r * math.sin(math.radians(30 + 60 * k))) for k in range(6)]
			)
			piece = hexagon.intersection(area)
			if piece.geom_type == "Polygon" and piece.area > 0.2:
				out.append(piece)
	return out, x0


class TestRegenerateHexaGrid(unittest.TestCase):
	def setUp(self):
		self.created_levels = []
		self.farm = self._ensure_farm()
		self.block = self._ensure_block()
		self.addCleanup(self._teardown)
		self._cleanup()
		self._seed()

	# ----------------------------------------------------------------- fixtures

	def _ensure_farm(self):
		for level in OLD_LEVELS + ("Has Triads",):
			if not frappe.db.exists("Farm Type", level):
				frappe.get_doc({"doctype": "Farm Type", "farm_type": level}).insert(ignore_permissions=True)
				self.created_levels.append(level)
		if frappe.db.exists("Farm", TEST_FARM):
			farm = frappe.get_doc("Farm", TEST_FARM)
			farm.set("farm_type", [{"farm_type": lv} for lv in OLD_LEVELS])
		else:
			farm = frappe.get_doc(
				{
					"doctype": "Farm",
					"farm_name": TEST_FARM,
					"farm_type": [{"farm_type": lv} for lv in OLD_LEVELS],
				}
			)
		farm.flags.ignore_mandatory = True
		farm.save(ignore_permissions=True) if not farm.is_new() else farm.insert(ignore_permissions=True)
		return farm.name

	def _ensure_block(self):
		existing = frappe.db.exists("Warehouse", {"warehouse_name": TEST_BLOCK_LABEL})
		if existing:
			frappe.db.set_value(
				"Warehouse", existing, {"custom_farm": self.farm, "warehouse_type": "Block"}, update_modified=False
			)
			return existing
		doc = frappe.get_doc(
			{
				"doctype": "Warehouse",
				"warehouse_name": TEST_BLOCK_LABEL,
				"company": frappe.db.get_value("Company", {}, "name"),
				"is_group": 0,
				"custom_farm": self.farm,
				"warehouse_type": "Block",
			}
		)
		doc.insert(ignore_permissions=True)
		return doc.name

	def _seed(self):
		inv = Transformer.from_crs(EPSG, "EPSG:4326", always_xy=True)
		hexagons, x0 = _hexagons()
		self.old = {}
		counters = {1: 0, 2: 0}
		for row in (1, 2):
			frappe.get_doc(
				{
					"doctype": "Bed",
					"name": f"{self.block} - Row {row}",
					"greenhouse": self.block,
					"unit_type": "Row",
					"bed": row,
					"farm": self.farm,
				}
			).db_insert()
		for hexagon in hexagons:
			row = 1 if hexagon.centroid.x < x0 + 15 else 2
			counters[row] += 1
			name = f"{self.block} - Row {row} - Triad {counters[row]}"
			ring = [[round(v, 7) for v in inv.transform(x, y)] for x, y in hexagon.exterior.coords]
			feature = {
				"type": "Feature",
				"properties": {"kind": "hexagon", "name": name},
				"geometry": {"type": "Polygon", "coordinates": [ring]},
			}
			frappe.get_doc(
				{
					"doctype": "Triad",
					"name": name,
					"row": f"{self.block} - Row {row}",
					"triad": counters[row],
					"block": self.block,
					"farm": self.farm,
					"geojson": json.dumps(feature),
				}
			).db_insert()
			self.old[name] = Polygon(ring)
		frappe.db.commit()

	def _cleanup(self):
		beds = frappe.get_all("Bed", filters={"greenhouse": self.block}, pluck="name")
		if beds:
			frappe.db.delete("Triad", {"row": ("in", beds)})
			frappe.db.delete("Bed", {"name": ("in", beds)})
		frappe.db.delete("Triad", {"block": self.block})
		frappe.db.delete("Trap", {"name": TEST_TRAP})
		frappe.db.delete("Orchard Tree", {"name": TEST_TREE})
		frappe.db.commit()

	def _teardown(self):
		"""Units first, then the block, the farm and any Farm Type this test made."""
		self._cleanup()
		frappe.delete_doc("Warehouse", self.block, force=True, ignore_permissions=True)
		frappe.delete_doc("Farm", self.farm, force=True, ignore_permissions=True)
		for level in self.created_levels:
			frappe.delete_doc("Farm Type", level, force=True, ignore_permissions=True)
		frappe.db.commit()

	def _assert_untouched(self, result, reason_part):
		row = result["blocks"][0]
		self.assertEqual(row["status"], "refused", result)
		self.assertIn(reason_part, row["reason"])
		beds, triads = self._counts()
		self.assertEqual(sorted(b.name for b in beds), [f"{self.block} - Row 1", f"{self.block} - Row 2"])
		self.assertEqual(sorted(triads), sorted(self.old))

	def _counts(self):
		beds = frappe.get_all("Bed", filters={"greenhouse": self.block}, fields=["name", "unit_type"])
		triads = frappe.get_all("Triad", filters={"block": self.block}, pluck="name")
		return beds, triads

	# ----------------------------------------------------------------- tests

	def test_apply_requires_confirm(self):
		with self.assertRaises(frappe.ValidationError):
			R.apply(farm=self.farm, blocks=[self.block])
		beds, triads = self._counts()
		self.assertEqual({b.unit_type for b in beds}, {"Row"})
		self.assertEqual(len(triads), len(self.old))

	def test_apply_is_idempotent(self):
		plan = R.plan_block(self.block)
		self.assertEqual(plan["status"], "ready")
		self.assertTrue(plan["area_ok"], plan)
		self.assertEqual(plan["old_rows"], 2)
		self.assertEqual(plan["old_triads"], len(self.old))

		first = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		self.assertEqual(first["blocks"][0]["status"], "applied", first)
		beds1, triads1 = self._counts()
		self.assertEqual({b.unit_type for b in beds1}, {"Hexa"})
		self.assertEqual(len(beds1), plan["hexas"])
		self.assertEqual(len(triads1), plan["triads"])

		second = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		self.assertEqual(second["blocks"][0]["status"], "already_hexa", second)
		beds2, triads2 = self._counts()
		self.assertEqual(sorted(b.name for b in beds2), sorted(b.name for b in beds1))
		self.assertEqual(sorted(triads2), sorted(triads1))
		self.assertEqual(len(set(triads2)), len(triads2))

	def test_apply_remaps_trap(self):
		old_name, old_poly = next(iter(sorted(self.old.items(), key=lambda kv: -kv[1].area)))
		frappe.get_doc(
			{"doctype": "Trap", "name": TEST_TRAP, "farm": self.farm, "unit_type": "Triad", "unit": old_name}
		).db_insert()
		frappe.db.commit()

		R.apply(farm=self.farm, blocks=[self.block], confirm=1)

		new_unit = frappe.db.get_value("Trap", TEST_TRAP, "unit")
		self.assertNotEqual(new_unit, old_name)
		self.assertTrue(frappe.db.exists("Triad", new_unit))
		ring = json.loads(frappe.db.get_value("Triad", new_unit, "geojson"))["geometry"]["coordinates"][0]
		self.assertTrue(Polygon(ring).buffer(1e-7).contains(Point(old_poly.centroid)))

	def test_inserted_triad_passes_validate(self):
		R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		levels = set(
			frappe.get_all("Farm Type Item", filters={"parenttype": "Farm", "parent": self.farm}, pluck="farm_type")
		)
		self.assertTrue({"Has Blocks", "Has Triads"} <= levels)

		names = frappe.get_all("Triad", filters={"block": self.block}, pluck="name", order_by="name")
		full_seen = False
		for name in names[:: max(1, len(names) // 12)]:
			doc = frappe.get_doc("Triad", name)
			doc.validate()  # raises if core's rules are broken
			self.assertEqual(name, f"{doc.row} - Triad {doc.triad}")
			self.assertTrue(doc.row.startswith(f"{self.block} - Hexa "))
			g = json.loads(doc.geojson)
			props, ring = g["properties"], g["geometry"]["coordinates"][0]
			self.assertEqual(props["kind"], "triad")
			self.assertEqual(props["name"], name)
			self.assertEqual(props["t"], doc.triad)
			self.assertEqual(ring[0], ring[-1])
			if not props["edge"]:
				full_seen = True
				self.assertEqual(len(ring), 4)  # [centre, a, b, centre]
		self.assertTrue(full_seen)
		hexa = frappe.get_doc("Bed", names[0].rsplit(" - Triad ", 1)[0])
		self.assertEqual(hexa.name, f"{hexa.greenhouse} - {hexa.unit_type} {hexa.bed}")
		hexa.validate()

	def test_area_fail_block_is_refused(self):
		original = R.AREA_TOLERANCE
		R.AREA_TOLERANCE = -1.0  # nothing can pass
		try:
			plan = R.plan_block(self.block)
			self.assertFalse(plan["area_ok"])
			result = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		finally:
			R.AREA_TOLERANCE = original
		self._assert_untouched(result, "Area check failed")

	def test_trap_without_geometry_refuses_block(self):
		old_name = sorted(self.old)[0]
		frappe.db.set_value("Triad", old_name, "geojson", None, update_modified=False)
		frappe.get_doc(
			{"doctype": "Trap", "name": TEST_TRAP, "farm": self.farm, "unit_type": "Triad", "unit": old_name}
		).db_insert()
		frappe.db.commit()
		result = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		self.assertEqual(result["blocks"][0]["reason"], f"Trap {TEST_TRAP} on {old_name} has no geometry.")
		self._assert_untouched(result, "has no geometry")
		self.assertEqual(frappe.db.get_value("Trap", TEST_TRAP, "unit"), old_name)

	def test_trap_on_old_row_refuses_block(self):
		frappe.get_doc(
			{"doctype": "Trap", "name": TEST_TRAP, "farm": self.farm, "unit_type": "Bed", "unit": f"{self.block} - Row 1"}
		).db_insert()
		frappe.db.commit()
		result = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		self._assert_untouched(result, "Trap (Bed): 1")

	def test_orchard_tree_on_old_row_refuses_block(self):
		frappe.get_doc(
			{"doctype": "Orchard Tree", "name": TEST_TREE, "row": f"{self.block} - Row 2"}
		).db_insert()
		frappe.db.commit()
		result = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		self._assert_untouched(result, "Orchard Tree.row: 1")

	def test_apply_result_keeps_trap_moves(self):
		old_name = sorted(self.old)[0]
		frappe.get_doc(
			{"doctype": "Trap", "name": TEST_TRAP, "farm": self.farm, "unit_type": "Triad", "unit": old_name}
		).db_insert()
		frappe.db.commit()
		result = R.apply(farm=self.farm, blocks=[self.block], confirm=1)
		moves = result["blocks"][0]["traps"]
		self.assertEqual([(m["trap"], m["old"]) for m in moves], [(TEST_TRAP, old_name)])
		self.assertEqual(frappe.db.get_value("Trap", TEST_TRAP, "unit"), moves[0]["new"])
