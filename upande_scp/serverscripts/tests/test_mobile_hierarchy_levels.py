"""`getFarmHierarchyInfo` / `getFarmDataBundle` section and level derivation.

Builds throwaway warehouse trees inside a transaction and rolls them back.
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.mobile import get_farm_data_bundle as bundle_mod
from upande_scp.serverscripts.mobile.get_farm_hierarchy_info import getFarmHierarchyInfo

FARM = "ZZ Hier Test Farm"


def _ensure_type(name):
	if not frappe.db.exists("Warehouse Type", name):
		frappe.get_doc({"doctype": "Warehouse Type", "name": name}).insert(ignore_permissions=True)


def _wh(name, wtype, parent, group, farm=True):
	doc = frappe.get_doc(
		{
			"doctype": "Warehouse",
			"warehouse_name": name,
			"warehouse_type": wtype,
			"parent_warehouse": parent,
			"is_group": group,
			"company": frappe.defaults.get_defaults().get("company")
			or frappe.db.get_value("Company", {}, "name"),
		}
	)
	if farm:
		doc.custom_farm = FARM
	doc.insert(ignore_permissions=True)
	return doc.name


class TestHierarchyLevels(unittest.TestCase):
	def setUp(self):
		for t in ("Farm", "Phase", "Section", "Pivot", "Block"):
			_ensure_type(t)
		if not frappe.db.exists("Farm", FARM):
			frappe.get_doc({
					"doctype": "Farm",
					"farm_name": FARM,
					"abbreviation": "ZZH",
					"company": frappe.db.get_value("Company", {}, "name"),
					"farm_type": [{"farm_type": "Has Blocks"}],
				}).insert(
				ignore_permissions=True
			)

	def tearDown(self):
		frappe.db.rollback()

	def _info(self):
		frappe.local.response = frappe._dict()
		return getFarmHierarchyInfo(FARM)["data"]

	def _bundle(self, crop=None, crops=None):
		"""``crops`` stubs planting.crops_for_stations (the Crop Scouted fields
		may not be migrated on every site); None leaves it unresolved."""
		stub = (lambda names: {n: (crops or {}).get(n) for n in names})
		with mock.patch.object(bundle_mod, "_crops_for", stub):
			return bundle_mod._with_crops(bundle_mod._build_farm_bundle(FARM), crop)

	def test_phase_section_block(self):
		farm = _wh("ZZH Farm", "Farm", None, 1)
		ph = _wh("ZZH Phase1", "Phase", farm, 1)
		sec = _wh("ZZH Sec1", "Section", ph, 1)
		blk = _wh("ZZH Blk1", "Block", sec, 0)
		info = self._info()
		self.assertEqual(info["farm_warehouse"], farm)
		self.assertEqual([s["name"] for s in info["sections"]], [sec])
		self.assertTrue(info["has_sections"])
		self.assertEqual(
			[(l["name"], l["warehouse_type"], l["parent"]) for l in info["levels"]],
			[(ph, "Phase", farm), (sec, "Section", ph)],
		)
		b = self._bundle()
		self.assertEqual([s["name"] for s in b["sections"]], [sec])
		self.assertEqual(b["levels"], info["levels"])
		station = next(w for w in b["warehouses"] if w["name"] == blk)
		self.assertEqual(station["parent"], sec)
		self.assertIn("crop", station)

	def test_pivot_block(self):
		farm = _wh("ZZH Farm", "Farm", None, 1)
		pv = _wh("ZZH Pivot1", "Pivot", farm, 1)
		_wh("ZZH BlkA", "Block", pv, 0)
		info = self._info()
		self.assertEqual([s["name"] for s in info["sections"]], [pv])
		self.assertEqual([l["name"] for l in info["levels"]], [pv])
		self.assertEqual(info["levels"][0]["warehouse_type"], "Pivot")

	def test_kaitet_shape_unchanged(self):
		farm = _wh("ZZH Farm", "Farm", None, 1)
		sec = _wh("ZZH SecK", "Section", farm, 1)
		_wh("ZZH BlkK", "Block", sec, 0)
		info = self._info()
		self.assertEqual(
			info["sections"], [{"name": sec, "warehouse_name": "ZZH SecK"}]
		)
		self.assertEqual([l["name"] for l in info["levels"]], [sec])
		b = self._bundle()
		self.assertEqual(b["sections"], info["sections"])

	def test_no_sections_when_blocks_under_farm(self):
		farm = _wh("ZZH Farm", "Farm", None, 1)
		_wh("ZZH BlkF", "Block", farm, 0)
		info = self._info()
		self.assertEqual(info["sections"], [])
		self.assertEqual(info["levels"], [])
		self.assertFalse(info["has_sections"])

	def test_crop_filter_drops_unmatched_stations(self):
		farm = _wh("ZZH Farm", "Farm", None, 1)
		sec = _wh("ZZH SecC", "Section", farm, 1)
		_wh("ZZH BlkC", "Block", sec, 0)
		blk2 = _wh("ZZH BlkD", "Block", sec, 0)
		blk = frappe.db.get_value("Warehouse", {"warehouse_name": "ZZH BlkC"}, "name")
		crops = {blk: "Roses", blk2: "Avocado"}
		b = self._bundle(crop="Roses", crops=crops)
		blocks = [w for w in b["warehouses"] if w["warehouse_type"] == "Block"]
		self.assertEqual([w["name"] for w in blocks], [blk])
		self.assertEqual(blocks[0]["crop"], "Roses")
		self.assertEqual(len(b["sections"]), 1)
		b = self._bundle(crop="NoSuchCrop", crops=crops)
		self.assertFalse([w for w in b["warehouses"] if w["warehouse_type"] == "Block"])
		self.assertEqual(b["sections"], [])
		self.assertEqual(b["levels"], [])
		b = self._bundle(crops=crops)  # no filter: both stations kept
		self.assertEqual(
			sorted(w["crop"] for w in b["warehouses"] if w["warehouse_type"] == "Block"),
			["Avocado", "Roses"],
		)
