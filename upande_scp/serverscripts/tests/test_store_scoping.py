"""Store-level keeper scoping and the general chemical store.

The fallback is the important part: a keeper row with no `warehouse` — unmigrated,
or added by hand — must degrade to the farm's mapped stores rather than scoping to
nothing, or a half-migrated site shows an empty dashboard instead of the previous
behaviour.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_store_scoping
"""

import unittest

import frappe

from upande_scp.serverscripts.store import store_keeper_api as SK
from upande_scp.patches.v1_0 import setup_general_chemical_store as P

USER = "_test_scp_keeper@example.com"


class TestGeneralStore(unittest.TestCase):
    def test_a_general_store_exists_per_company_with_chemical_stores(self):
        companies = P._companies_with_chemical_stores()
        self.assertTrue(companies, "no company has chemical stores on this site")
        for company in companies:
            abbr = frappe.db.get_value("Company", company, "abbr")
            self.assertTrue(
                frappe.db.exists("Warehouse", f"{P.GENERAL_STORE_PREFIX} - {abbr}"),
                f"no general store for {company}",
            )

    def test_the_general_store_belongs_to_no_farm(self):
        """Blank custom_farm is what makes ~108 farm-scoped queries exclude the
        shared pool from every farm's stock."""
        for company in P._companies_with_chemical_stores():
            abbr = frappe.db.get_value("Company", company, "abbr")
            wh = f"{P.GENERAL_STORE_PREFIX} - {abbr}"
            self.assertFalse(
                frappe.db.get_value("Warehouse", wh, "custom_farm"),
                f"{wh} has a farm; it would count as that farm's stock",
            )

    def test_it_sits_at_the_company_root_not_under_a_farm(self):
        for company in P._companies_with_chemical_stores():
            abbr = frappe.db.get_value("Company", company, "abbr")
            parent = frappe.db.get_value(
                "Warehouse", f"{P.GENERAL_STORE_PREFIX} - {abbr}", "parent_warehouse"
            )
            self.assertFalse(
                frappe.db.get_value("Warehouse", parent, "custom_farm"),
                "general store is parented under a farm group",
            )

    def test_creating_again_is_a_no_op(self):
        self.assertEqual(P.create_general_stores(), [])

    def test_backfill_leaves_an_already_set_store_alone(self):
        before = frappe.get_all(
            "Farm Store Keeper",
            filters={"parenttype": "Farm", "warehouse": ("is", "set")},
            fields=["name", "warehouse"],
        )
        if not before:
            self.skipTest("no keeper rows bound to a store")
        P.backfill_keeper_stores()
        for row in before:
            self.assertEqual(
                frappe.db.get_value("Farm Store Keeper", row.name, "warehouse"),
                row.warehouse,
                "backfill overwrote an existing store assignment",
            )


class TestStoreScoping(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_elevated_users_are_unscoped(self):
        self.assertIsNone(SK.allowed_stores_for("Administrator"))

    def test_a_keeper_scopes_to_the_store_named_on_their_row(self):
        row = frappe.db.get_value(
            "Farm Store Keeper",
            {"parenttype": "Farm", "warehouse": ("is", "set")},
            ["user", "warehouse"], as_dict=True,
        )
        if not row:
            self.skipTest("no keeper bound to a store")
        stores = SK.allowed_stores_for(row.user)
        # Not None (they are scoped) and the named store is included.
        self.assertIsNotNone(stores)
        self.assertIn(row.warehouse, stores)

    def test_a_row_with_no_store_falls_back_to_the_farms_mapped_stores(self):
        """The migration-safety property: an unset warehouse must not scope to
        nothing, or a half-migrated site shows an empty dashboard.

        Exercises `allowed_stores_for` for real — with a genuinely non-elevated
        user, since Administrator short-circuits to None and would prove nothing.
        """
        farm = frappe.db.get_value(
            "Farm", {"custom_chemical_store": ("is", "set")}, "name"
        )
        if not farm:
            self.skipTest("no farm with a mapped chemical store")
        mapped = frappe.db.get_value("Farm", farm, "custom_chemical_store")

        if not frappe.db.exists("User", USER):
            frappe.get_doc({
                "doctype": "User", "email": USER, "first_name": "scp-keeper-test",
                "send_welcome_email": 0, "enabled": 1,
            }).insert(ignore_permissions=True)

        # Inserted as a child row directly rather than via Farm.save(): some
        # Farms carry spray_plan_approvers rows for users who no longer hold the
        # required role, so saving the parent throws on unrelated pre-existing
        # data. Same dodge the role migration needed.
        row = frappe.get_doc({
            "doctype": "Farm Store Keeper",
            "parent": farm,
            "parenttype": "Farm",
            "parentfield": "store_keepers",
            "user": USER,
            # warehouse deliberately left blank — this is the fallback case
        })
        row.flags.ignore_links = True
        row.insert(ignore_permissions=True)
        frappe.db.commit()
        try:
            stores = SK.allowed_stores_for(USER)
            self.assertIsNotNone(stores, "a plain keeper must be scoped, not unscoped")
            self.assertIn(
                mapped, stores,
                "an unset warehouse did not fall back to the farm's mapped store",
            )
        finally:
            frappe.delete_doc(
                "Farm Store Keeper", row.name, force=True, ignore_permissions=True
            )
            frappe.db.commit()

    def test_an_unassigned_user_scopes_to_nothing_not_everything(self):
        # Empty list, never None — None means "sees everything".
        stores = SK.allowed_stores_for(USER)
        self.assertIsNotNone(stores)
        self.assertEqual(stores, [])
