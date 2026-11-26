"""Every crop has its own Approvals page (`#/<crop>/approvals`).

Work Orders carry no crop, so a plan belongs to the crop of the place it is for:
`crop_catalog.crop_for_greenhouse`, which on a mixed farm (Mutara: avocado blocks
and vegetable pivots) is what the block is planted with. The three lists the page
reads — pending, stage summary, stale — all take `crop`; blank keeps every crop.
"""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog as C
from upande_scp.serverscripts.spray_plan_creator import lifecycle as L
from upande_scp.serverscripts.spray_plan_creator import reservations as R
from upande_scp.serverscripts.spray_plan_ops import spray_plan_approval as A

CROPS = {"GH-A": "Avocado", "GH-P": "Potato", "GH-X": None}


def _rows():
	return [
		frappe._dict(name="WO-A", custom_greenhouse="GH-A"),
		frappe._dict(name="WO-P", custom_greenhouse="GH-P"),
		frappe._dict(name="WO-X", custom_greenhouse="GH-X"),
	]


class TestKeepCrop(unittest.TestCase):
	def setUp(self):
		self.p1 = patch.object(C, "crops_for_greenhouses", side_effect=lambda whs: {w: CROPS.get(w) for w in whs})
		self.p2 = patch.object(C, "canonical", side_effect=lambda c: {"avocado": "Avocado", "potato": "Potato"}.get((c or "").strip().lower(), ""))
		self.p1.start()
		self.p2.start()

	def tearDown(self):
		self.p1.stop()
		self.p2.stop()

	def test_blank_crop_keeps_everything(self):
		self.assertEqual([r.name for r in C.keep_crop(_rows(), None)], ["WO-A", "WO-P", "WO-X"])
		self.assertEqual(len(C.keep_crop(_rows(), "  ")), 3)

	def test_a_crop_keeps_only_its_places(self):
		self.assertEqual([r.name for r in C.keep_crop(_rows(), "Avocado")], ["WO-A"])
		self.assertEqual([r.name for r in C.keep_crop(_rows(), "potato")], ["WO-P"])

	def test_an_unknown_crop_keeps_nothing_rather_than_everything(self):
		self.assertEqual(C.keep_crop(_rows(), "Banana"), [])

	def test_a_place_with_no_crop_shows_under_no_crop_page(self):
		for crop in ("Avocado", "Potato"):
			self.assertNotIn("WO-X", [r.name for r in C.keep_crop(_rows(), crop)])


class TestBatchMatchesSingle(unittest.TestCase):
	def test_batch_agrees_with_crop_for_greenhouse(self):
		whs = frappe.get_all("Warehouse", filters={"custom_farm": ["is", "set"]}, pluck="name", limit=60)
		if not whs:
			self.skipTest("no farm warehouses on this site")
		batch = C.crops_for_greenhouses(whs)
		for w in whs:
			self.assertEqual(batch[w], C.crop_for_greenhouse(w), w)

	def test_empty_input(self):
		self.assertEqual(C.crops_for_greenhouses([]), {})
		self.assertEqual(C.crops_for_greenhouses([None, ""]), {})


class TestEndpointsTakeCrop(unittest.TestCase):
	"""The three lists split by crop. Each crop's page shows a subset of the
	all-crop list, and no plan shows on two crops' pages."""

	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		crops = frappe.get_all("Crop Scouted", pluck="name")
		if len(crops) < 2:
			raise unittest.SkipTest("needs two crops")
		cls.crops = crops

	def _split(self, fetch, key):
		everything = {r[key] for r in fetch(None)}
		seen = {}
		for crop in self.crops:
			names = {r[key] for r in fetch(crop)}
			self.assertTrue(names <= everything, crop)
			for n in names:
				self.assertNotIn(n, seen, f"{n} on {seen.get(n)} and {crop}")
				seen[n] = crop
		return everything, seen

	def test_pending(self):
		self._split(lambda c: A.get_pending_work_orders(crop=c)["work_orders"], "name")

	def test_stage_summary(self):
		self._split(lambda c: L.get_lifecycle_summary(crop=c), "name")

	def test_stale(self):
		self._split(lambda c: R.get_stale_plans(crop=c), "name")

	def test_a_plan_shows_on_its_places_crop(self):
		res = A.get_pending_work_orders()["work_orders"]
		if not res:
			self.skipTest("nothing awaiting approval")
		wo = res[0]
		crop = C.crop_for_greenhouse(wo["custom_greenhouse"])
		if not crop:
			self.skipTest("first plan's place has no crop")
		names = [w["name"] for w in A.get_pending_work_orders(crop=crop)["work_orders"]]
		self.assertIn(wo["name"], names)

	def test_an_unknown_crop_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			A.get_pending_work_orders(crop="Not A Crop")


class TestBedCrops(unittest.TestCase):
	def test_bed_crops_follow_warehouse_type_not_name(self):
		beds = C.bed_crops()
		for crop in beds:
			self.assertIn(crop, C.catalog().get("crops", []))
		# A crop with no Greenhouse-type warehouse is planned by block.
		farm_crop = C.catalog().get("farm_crop", {})
		gh_farms = set(
			frappe.get_all(
				"Warehouse",
				filters={"warehouse_type": "Greenhouse", "is_group": 0, "custom_farm": ["is", "set"]},
				pluck="custom_farm",
			)
		)
		self.assertEqual(set(beds), {farm_crop[f] for f in gh_farms if f in farm_crop})


class TestEmptyBlockOnMixedFarm(unittest.TestCase):
	"""An empty block takes its farm's crop only when the farm grows one crop."""

	def test_index_lists_every_crop_of_a_farm(self):
		idx = C.build_index(
			["Avocado", "Potato"], [], [],
			[{"parent": "Avocado", "farm": "Mixed"}, {"parent": "Potato", "farm": "Mixed"},
			 {"parent": "Avocado", "farm": "Solo"}],
			[],
		)
		self.assertEqual(idx["farms_crops"], {"Mixed": ["Avocado", "Potato"], "Solo": ["Avocado"]})

	def test_mixed_farm_empty_block_has_no_crop(self):
		cat = {"farm_crop": {"Mixed": "Avocado", "Solo": "Avocado"},
		       "farms_crops": {"Mixed": ["Avocado", "Potato"], "Solo": ["Avocado"]}}
		with patch.object(C, "catalog", return_value=cat):
			self.assertIsNone(C.block_fallback_crop("Mixed"))
			self.assertEqual(C.block_fallback_crop("Solo"), "Avocado")
			self.assertIsNone(C.block_fallback_crop(None))
