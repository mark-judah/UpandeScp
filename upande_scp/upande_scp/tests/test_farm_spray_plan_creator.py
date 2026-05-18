import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.upande_scp.tests._helpers import (
    ensure_farm, ensure_role, ensure_user, cleanup_user,
)


class TestFarmSprayPlanCreator(FrappeTestCase):
    def setUp(self):
        ensure_role("Spray Plan Creator")
        self.farm = ensure_farm("Test Farm A1")
        self.creator = ensure_user("a1.creator@example.com", roles=["Spray Plan Creator"])
        self.non_creator = ensure_user("a1.noncreator@example.com", roles=[])

    def tearDown(self):
        if frappe.db.exists("Farm", self.farm):
            frappe.delete_doc("Farm", self.farm, force=1, ignore_permissions=True)
        cleanup_user("a1.creator@example.com")
        cleanup_user("a1.noncreator@example.com")
        frappe.db.commit()

    def test_adding_a_creator_works(self):
        farm = frappe.get_doc("Farm", self.farm)
        farm.append("spray_plan_creators", {"user": self.creator})
        farm.save(ignore_permissions=True)
        farm.reload()
        users = {row.user for row in (farm.spray_plan_creators or [])}
        self.assertIn(self.creator, users)

    def test_adding_a_non_creator_user_raises(self):
        farm = frappe.get_doc("Farm", self.farm)
        farm.append("spray_plan_creators", {"user": self.non_creator})
        with self.assertRaisesRegex(frappe.ValidationError, "Spray Plan Creator"):
            farm.save(ignore_permissions=True)
