"""Crop Scouted's farm-tag sanity warning accepts Hexa or Row layouts for tree crops."""

import unittest
from unittest import mock

import frappe

from upande_scp.upande_scp.doctype.crop_scouted import crop_scouted as CS


class TestCropUnitKinds(unittest.TestCase):
	def test_coffee_accepts_hexa_or_row(self):
		self.assertEqual(CS.UNIT_TYPES_BY_CROP["Coffee"], ("Row", "Hexa"))

	def test_avocado_accepts_hexa_or_row(self):
		self.assertEqual(CS.UNIT_TYPES_BY_CROP["Avocado"], ("Row", "Hexa"))

	def test_rose_only_beds(self):
		self.assertEqual(CS.UNIT_TYPES_BY_CROP["Rose"], ("Bed",))

	def _doc(self, farm):
		doc = CS.CropScouted.__new__(CS.CropScouted)
		doc.name = "Coffee"
		doc.farms = [frappe._dict(farm=farm)]
		return doc

	def test_warning_lists_farms_without_any_allowed_kind(self):
		def fake_sql(query, values=None, *a, **kw):
			self.assertIn("IN %(kinds)s", query)
			self.assertEqual(tuple(values["kinds"]), ("Row", "Hexa"))
			return [(1,)] if values["farm"] == "HasRows" else []

		with mock.patch.object(frappe.db, "sql", side_effect=fake_sql), mock.patch.object(
			frappe, "msgprint"
		) as msg:
			self._doc("HasRows")._warn_about_farms_without_units()
			msg.assert_not_called()
			self._doc("Empty Farm")._warn_about_farms_without_units()
			self.assertEqual(msg.call_count, 1)
			text = msg.call_args[0][0]
			self.assertIn("Empty Farm", text)
			self.assertIn("hexas or rows", text)
