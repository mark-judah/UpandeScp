import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.bootstrap import fetch_creator_bootstrap
from upande_scp.upande_scp.tests._helpers import (
    assign_creator, cleanup_user, ensure_farm, ensure_role, ensure_user,
)


class TestBootstrap(FrappeTestCase):
    def setUp(self):
        ensure_role("Spray Plan Creator")
        self.farm = ensure_farm("BootstrapFarm")
        self.creator = ensure_user("bootstrap.creator@example.com",
                                   roles=["Spray Plan Creator"])
        assign_creator(self.creator, [self.farm])
        if not frappe.db.exists("Warehouse", {"warehouse_name": "BootstrapGH-1"}):
            frappe.get_doc({
                "doctype": "Warehouse", "warehouse_name": "BootstrapGH-1",
                "warehouse_type": "Greenhouse", "custom_farm": self.farm,
                "company": frappe.defaults.get_global_default("company"),
            }).insert(ignore_permissions=True)

    def tearDown(self):
        wh = frappe.db.get_value("Warehouse", {"warehouse_name": "BootstrapGH-1"}, "name")
        if wh:
            frappe.delete_doc("Warehouse", wh, force=1, ignore_permissions=True)
        if frappe.db.exists("Farm", self.farm):
            frappe.delete_doc("Farm", self.farm, force=1, ignore_permissions=True)
        cleanup_user(self.creator)
        frappe.db.commit()

    def test_unassigned_user_returns_empty_scope(self):
        unassigned = ensure_user("bootstrap.unassigned@example.com",
                                 roles=["Spray Plan Creator"])
        try:
            frappe.set_user(unassigned)
            data = fetch_creator_bootstrap()
            self.assertEqual(data["scope"]["farms"], [])
        finally:
            frappe.set_user("Administrator")
            cleanup_user(unassigned)

    def test_assigned_user_sees_scope_data(self):
        frappe.set_user(self.creator)
        try:
            data = fetch_creator_bootstrap()
            self.assertEqual(set(data["scope"]["farms"]), {self.farm})
            gh_names = {gh["name"] for gh in data["greenhouses"]}
            self.assertTrue(any("BootstrapGH-1" in n for n in gh_names),
                            f"Expected BootstrapGH-1 in {gh_names}")
            self.assertIn("irac_window_days", data)
            self.assertIn("frac_window_days", data)
            self.assertIn("weather_settings", data)
            self.assertIn("pest_catalog", data)
            self.assertIn("disease_catalog", data)
        finally:
            frappe.set_user("Administrator")

    def test_response_shape_keys(self):
        frappe.set_user(self.creator)
        try:
            data = fetch_creator_bootstrap()
            for key in ("scope", "greenhouses", "kits", "spray_teams", "tank_mixes",
                        "rate_limits", "pest_catalog", "disease_catalog",
                        "weather_settings", "irac_window_days", "frac_window_days"):
                self.assertIn(key, data, f"Missing key: {key}")
        finally:
            frappe.set_user("Administrator")
