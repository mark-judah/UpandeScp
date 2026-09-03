"""A CSU Chemical Transfer carries the spray plan's own cost centre.

A spray plan resolves a cost centre when it is created — the operator's override,
else the greenhouse — and stores it on the Work Order as `custom_cost_center`.
Chemical Mixing and Chemical Spray have always read it back. The transfer did
not: ERPNext builds that entry itself (`work_order.make_stock_entry`, called from
`spray_plan_approval.approve_single_work_order`) and knows nothing about the
field, so its rows fell through to the Item Default buying cost centre and then
the Company default. Where both are blank ERPNext refuses the entry outright —
"Cost Center is mandatory for Item ..." — which is how the gap surfaced.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_transfer_cost_center
"""

import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import stock_entry_state as S

AFP_TYPE = "Application Floor Plan"


def _a_plan_with_a_cost_center():
    rows = frappe.db.sql(
        """
        SELECT name, custom_cost_center, company, wip_warehouse, source_warehouse
        FROM `tabWork Order`
        WHERE custom_type = %s AND IFNULL(custom_cost_center, '') <> ''
        ORDER BY modified DESC LIMIT 1
        """,
        (AFP_TYPE,),
        as_dict=True,
    )
    return rows[0] if rows else None


class TestTransferCostCenter(unittest.TestCase):
    """The hook is exercised through real Stock Entry docs, never saved."""

    @classmethod
    def setUpClass(cls):
        cls.wo = _a_plan_with_a_cost_center()
        cls.was = frappe.db.get_single_value(S.SETTINGS, "stamp_transfer_cost_center")

    @classmethod
    def tearDownClass(cls):
        frappe.db.set_single_value(S.SETTINGS, "stamp_transfer_cost_center", cls.was)
        frappe.db.rollback()

    def _transfer(self, work_order):
        wo = self.wo
        item = frappe.db.get_value(
            "Work Order Item", {"parent": wo.name},
            ["item_code", "source_warehouse"], as_dict=True,
        )
        se = frappe.new_doc("Stock Entry")
        se.purpose = S.TRANSFER_PURPOSE
        se.company = wo.company
        se.work_order = work_order
        se.append("items", {
            "item_code": item.item_code if item else None,
            "qty": 1,
            "s_warehouse": (item.source_warehouse if item else None) or wo.source_warehouse,
            "t_warehouse": wo.wip_warehouse,
        })
        return se

    def setUp(self):
        if not self.wo:
            self.skipTest("no Application Floor Plan with a cost centre on this site")

    def test_on_stamps_the_plans_cost_center(self):
        frappe.db.set_single_value(S.SETTINGS, "stamp_transfer_cost_center", 1)
        se = self._transfer(self.wo.name)
        S.before_validate(se, None)
        self.assertEqual(se.items[0].cost_center, self.wo.custom_cost_center)

    def test_off_leaves_it_to_erpnext(self):
        """Off must be a real off — the row is left for ERPNext's own chain."""
        frappe.db.set_single_value(S.SETTINGS, "stamp_transfer_cost_center", 0)
        se = self._transfer(self.wo.name)
        S.before_validate(se, None)
        self.assertIn(se.items[0].cost_center, (None, ""))

    def test_a_transfer_for_another_flow_is_untouched(self):
        """Material Transfer for Manufacture is shared with every other work
        order on the site. Only AFP plans are ours to stamp."""
        frappe.db.set_single_value(S.SETTINGS, "stamp_transfer_cost_center", 1)
        for work_order in (None, "", "WO-DOES-NOT-EXIST-0001"):
            se = self._transfer(work_order)
            S.before_validate(se, None)
            self.assertIn(se.items[0].cost_center, (None, ""))

    def test_the_resolver_prefers_what_the_plan_stored(self):
        self.assertEqual(S._afp_cost_center(self.wo.name), self.wo.custom_cost_center)

    def test_the_manufacture_branch_is_not_reached(self):
        """A transfer must never run the consumption rebuild — that would refuse
        the entry for having no transfer to rebuild from."""
        frappe.db.set_single_value(S.SETTINGS, "stamp_transfer_cost_center", 1)
        called = []
        original = S._before_validate_manufacture
        S._before_validate_manufacture = lambda doc: called.append(doc)
        try:
            S.before_validate(self._transfer(self.wo.name), None)
        finally:
            S._before_validate_manufacture = original
        self.assertEqual(called, [])


class TestSettingIsWrittenDown(unittest.TestCase):
    def test_the_single_has_a_stored_value(self):
        """`get_single_value` casts a missing Check to 0, so an absent row reads
        as a deliberate off. The patch writes the default down for that reason —
        if this fails, the patch did not run and the feature is silently off."""
        stored = frappe.db.sql(
            "SELECT value FROM `tabSingles` WHERE doctype = %s AND field = %s",
            (S.SETTINGS, "stamp_transfer_cost_center"),
        )
        self.assertTrue(stored, "stamp_transfer_cost_center_on patch has not run")

    def test_the_field_lives_on_the_accounts_tab(self):
        meta = frappe.get_meta(S.SETTINGS)
        self.assertIn("Accounts", [f.label for f in meta.fields if f.fieldtype == "Tab Break"])
        self.assertTrue(meta.get_field("stamp_transfer_cost_center"))
