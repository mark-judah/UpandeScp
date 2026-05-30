# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.tests.utils import FrappeTestCase


class TestPestFilterStandalone(FrappeTestCase):
    def setUp(self):
        if not frappe.db.exists("Pest", "_TEST PF Pest"):
            frappe.get_doc({"doctype": "Pest", "common_name": "_TEST PF Pest"}).insert(
                ignore_permissions=True
            )
        if not frappe.db.exists("Crop Scouted", "_TEST PF Crop"):
            frappe.get_doc(
                {"doctype": "Crop Scouted", "crop_name": "_TEST PF Crop"}
            ).insert(ignore_permissions=True)

    def _make_filter_with_stages(self):
        pf = frappe.get_doc(
            {
                "doctype": "Pest Filter",
                "crop_scouted": "_TEST PF Crop",
                "pest": "_TEST PF Pest",
                "stages": [
                    {"stage": "Adult", "reading_type": "Count"},
                    {"stage": "Larvae", "reading_type": "Count"},
                ],
            }
        )
        pf.insert(ignore_permissions=True)
        return pf

    def test_stages_survive_resave(self):
        """The original bug: re-saving must not orphan the stages."""
        pf = self._make_filter_with_stages()
        name = pf.name

        # Re-save several times, the way an operator edit would.
        for _ in range(3):
            doc = frappe.get_doc("Pest Filter", name)
            doc.unit = "Per Zone %"
            doc.save(ignore_permissions=True)

        stages = frappe.get_all(
            "Pests Stages",
            filters={"parent": name, "parenttype": "Pest Filter"},
            pluck="stage",
        )
        self.assertEqual(sorted(stages), ["Adult", "Larvae"])

    def test_crop_scouted_filtering(self):
        pf = self._make_filter_with_stages()
        rows = frappe.get_all(
            "Pest Filter", filters={"crop_scouted": "_TEST PF Crop"}, pluck="name"
        )
        self.assertIn(pf.name, rows)

    def test_crop_delete_cascades(self):
        pf = self._make_filter_with_stages()
        frappe.delete_doc("Crop Scouted", "_TEST PF Crop", ignore_permissions=True, force=True)
        self.assertFalse(frappe.db.exists("Pest Filter", pf.name))
        self.assertFalse(
            frappe.db.exists(
                "Pests Stages", {"parent": pf.name, "parenttype": "Pest Filter"}
            )
        )
