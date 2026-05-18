import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.scope import _resolve_user_scope
from upande_scp.upande_scp.tests._helpers import (
    assign_creator, cleanup_user, ensure_farm, ensure_role, ensure_user,
)


class TestScopeResolution(FrappeTestCase):
    def setUp(self):
        ensure_role("Spray Plan Creator")
        self.farm_a = ensure_farm("ScopeFarmA")
        self.farm_b = ensure_farm("ScopeFarmB")
        self.creator = ensure_user("scope.creator@example.com", roles=["Spray Plan Creator"])
        self.bystander = ensure_user("scope.bystander@example.com", roles=[])
        # Two warehouses, one per farm, of type Greenhouse
        for name, farm in (("ScopeGH-A", "ScopeFarmA"), ("ScopeGH-B", "ScopeFarmB")):
            if not frappe.db.exists("Warehouse", {"warehouse_name": name}):
                frappe.get_doc({
                    "doctype": "Warehouse", "warehouse_name": name,
                    "warehouse_type": "Greenhouse", "custom_farm": farm,
                    "company": frappe.defaults.get_global_default("company"),
                }).insert(ignore_permissions=True)

    def tearDown(self):
        for n in ("ScopeGH-A", "ScopeGH-B"):
            wh = frappe.db.get_value("Warehouse", {"warehouse_name": n}, "name")
            if wh:
                frappe.delete_doc("Warehouse", wh, force=1, ignore_permissions=True)
        for f in (self.farm_a, self.farm_b):
            if frappe.db.exists("Farm", f):
                frappe.delete_doc("Farm", f, force=1, ignore_permissions=True)
        cleanup_user(self.creator)
        cleanup_user(self.bystander)
        frappe.db.commit()

    def test_unassigned_user_returns_empty(self):
        scope = _resolve_user_scope(self.creator)
        self.assertEqual(scope["farms"], [])
        self.assertEqual(scope["warehouses"], [])
        self.assertEqual(scope["greenhouses"], [])

    def test_single_farm_returns_only_that_farm_warehouses(self):
        assign_creator(self.creator, [self.farm_a])
        scope = _resolve_user_scope(self.creator)
        self.assertEqual(set(scope["farms"]), {self.farm_a})
        gh_names = {w["name"] for w in scope["greenhouses"]}
        self.assertTrue(any("ScopeGH-A" in n for n in gh_names))
        self.assertFalse(any("ScopeGH-B" in n for n in gh_names))

    def test_multi_farm_returns_union(self):
        assign_creator(self.creator, [self.farm_a, self.farm_b])
        scope = _resolve_user_scope(self.creator)
        self.assertEqual(set(scope["farms"]), {self.farm_a, self.farm_b})
        gh_names = {w["name"] for w in scope["greenhouses"]}
        self.assertTrue(any("ScopeGH-A" in n for n in gh_names))
        self.assertTrue(any("ScopeGH-B" in n for n in gh_names))

    def test_non_creator_returns_empty(self):
        scope = _resolve_user_scope(self.bystander)
        self.assertEqual(scope["farms"], [])
