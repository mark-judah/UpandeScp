import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.admin import (
    list_farms_with_creators, list_spray_plan_creator_candidates, set_farm_creators,
)
from upande_scp.upande_scp.tests._helpers import (
    cleanup_user, ensure_farm, ensure_role, ensure_user,
)


class TestAdminEndpoints(FrappeTestCase):
    def setUp(self):
        ensure_role("Spray Plan Creator")
        ensure_role("General Manager")
        self.farm = ensure_farm("AdminFarmTest")
        self.creator = ensure_user("admin.creator@example.com",
                                   roles=["Spray Plan Creator"], full_name="Admin Creator")
        self.gm = ensure_user("admin.gm@example.com", roles=["General Manager"])
        self.no_role = ensure_user("admin.norole@example.com", roles=[])

    def tearDown(self):
        if frappe.db.exists("Farm", self.farm):
            frappe.delete_doc("Farm", self.farm, force=1, ignore_permissions=True)
        for u in (self.creator, self.gm, self.no_role):
            cleanup_user(u)
        frappe.db.commit()

    def test_list_farms_includes_empty_creators(self):
        rows = list_farms_with_creators()
        names = [r["farm"] for r in rows]
        self.assertIn(self.farm, names)
        row = next(r for r in rows if r["farm"] == self.farm)
        self.assertEqual(row["creators"], [])

    def test_candidates_only_returns_creator_role_users(self):
        cands = list_spray_plan_creator_candidates("admin.")
        emails = {c["user"] for c in cands}
        self.assertIn(self.creator, emails)
        self.assertNotIn(self.no_role, emails)
        self.assertNotIn(self.gm, emails)  # GM != Spray Plan Creator

    def test_set_farm_creators_idempotent(self):
        set_farm_creators(self.farm, [self.creator])
        set_farm_creators(self.farm, [self.creator])  # second call shouldn't duplicate
        farm = frappe.get_doc("Farm", self.farm)
        users = [r.user for r in (farm.spray_plan_creators or [])]
        self.assertEqual(users, [self.creator])

    def test_set_farm_creators_replaces(self):
        set_farm_creators(self.farm, [self.creator])
        set_farm_creators(self.farm, [])
        farm = frappe.get_doc("Farm", self.farm)
        self.assertEqual(farm.spray_plan_creators, [])

    def test_set_farm_creators_rejects_non_creator(self):
        with self.assertRaises(frappe.ValidationError):
            set_farm_creators(self.farm, [self.no_role])
