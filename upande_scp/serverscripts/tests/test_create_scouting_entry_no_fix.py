"""createScoutingEntry saves a record with no coordinates and stores gps_fix_status.

Run: bench --site mutara.local run-tests \
        --module upande_scp.serverscripts.tests.test_create_scouting_entry_no_fix
"""

from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from upande_scp.serverscripts.common import planting
from upande_scp.serverscripts.mobile import create_scouting_entry as CSE

P1_BLOCK = "P1-B1 - MUT"  # under Pivot 1 - MUT
PH1_BLOCK = "PH1-B1 - MUT"  # under Phase 1 - MUT
DAY = "2026-10-01"


class TestNoFixScoutingEntry(IntegrationTestCase):
	def tearDown(self):
		frappe.db.rollback()

	def _send(self, **over):
		user = frappe.db.get_value("Employee", {"user_id": ["is", "set"]}, "user_id")
		entry = {
			"scouts_name": user,
			"block": P1_BLOCK,
			"date_of_capture": DAY,
			"time_of_capture": "09:15:00",
		}
		entry.update(over)
		prev = getattr(frappe.local, "request", None)
		try:
			frappe.local.request = SimpleNamespace(get_json=lambda: entry)
			frappe.local.response = frappe._dict()
			with patch.object(frappe.db, "commit"), patch.object(frappe, "publish_realtime"):
				CSE.createScoutingEntry()
			result = frappe.local.response["data"][0]
		finally:
			frappe.local.request = prev
		self.assertEqual(result["status"], "success", result)
		return frappe.get_doc("Scouting Entry", result["name"]), frappe.get_doc(
			"Scouting Entry Metadata", result["metadata_name"]
		)

	def test_block_entry_without_row_or_coordinates_is_saved(self):
		doc, meta = self._send(latitude=None, longitude=None, accuracy=None, gps_fix_status="none")
		self.assertFalse(doc.bed)
		self.assertFalse(doc.tree)
		self.assertIsNone(doc.latitude)
		self.assertIsNone(doc.longitude)
		self.assertEqual(meta.gps_fix_status, "none")

	def test_phase_block_without_coordinates_is_saved(self):
		doc, meta = self._send(block=PH1_BLOCK, gps_fix_status="stale")
		self.assertIsNone(doc.latitude)
		self.assertEqual(meta.gps_fix_status, "stale")

	def test_coarse_fix_saved_with_status(self):
		doc, meta = self._send(latitude=-0.5, longitude=36.7, accuracy=40, gps_fix_status="coarse")
		self.assertEqual(meta.gps_fix_status, "coarse")
		self.assertEqual(float(doc.latitude), -0.5)

	def test_missing_status_leaves_field_blank(self):
		doc, meta = self._send(latitude=-0.5, longitude=36.7, accuracy=5)
		self.assertTrue(doc.name)
		self.assertFalse(meta.gps_fix_status)

	def test_crop_scouted_filled_from_station_when_blank(self):
		doc, _ = self._send(latitude=None, longitude=None)
		self.assertEqual(doc.crop_scouted, planting.crop_for_station(P1_BLOCK, DAY))
