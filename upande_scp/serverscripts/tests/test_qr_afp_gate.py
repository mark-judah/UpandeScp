"""Chemical QR labels belong to spray plans only.

`Material Transfer for Manufacture` is ERPNext's ordinary transfer-to-WIP
purpose, shared by every manufacturing flow on a site. Gating label minting on
purpose alone therefore issued chemical QR codes for every unrelated work
order's transfer to its shop floor.

The discriminator is the linked Work Order's `custom_type`. Nothing changes
app-side: the mobile app reads labels (`get_print_jobs`, scan verification), it
never mints them.

Also covers the Stock Entry Types the transfer depends on, which a fresh install
never seeded — see `spray_stock_types.ensure_spray_stock_entry_types`.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_qr_afp_gate
"""

import unittest
from types import SimpleNamespace

import frappe

from upande_scp.serverscripts.qr import chemical_labels as cl
from upande_scp.serverscripts.store import spray_stock_types as sst


class _FakeEntry(SimpleNamespace):
    """Enough of a Stock Entry for the gate. Never inserted."""


class TestIsLabelledTransfer(unittest.TestCase):
    def test_a_transfer_with_no_work_order_is_never_ours(self):
        """An AFP transfer is always minted against its plan, so a work-order-less
        transfer cannot be one."""
        self.assertFalse(cl.is_labelled_transfer(_FakeEntry(work_order=None)))
        self.assertFalse(cl.is_labelled_transfer(_FakeEntry(work_order="")))

    def test_a_missing_work_order_is_not_ours(self):
        self.assertFalse(
            cl.is_labelled_transfer(_FakeEntry(work_order="WO-DOES-NOT-EXIST-0001"))
        )

    def test_issue_returns_nothing_for_a_non_afp_transfer(self):
        """The regression: right purpose, right docstatus, wrong work order."""
        entry = _FakeEntry(
            purpose=cl.TRANSFER_PURPOSE,
            docstatus=1,
            work_order="WO-DOES-NOT-EXIST-0001",
            name="SE-FAKE-0001",
            items=[],
        )
        self.assertEqual(cl.issue_for_stock_entry(entry), [])

    def test_issue_still_short_circuits_on_purpose_and_docstatus(self):
        for entry in (
            _FakeEntry(purpose="Material Issue", docstatus=1, work_order=None, items=[]),
            _FakeEntry(purpose=cl.TRANSFER_PURPOSE, docstatus=0, work_order=None, items=[]),
            _FakeEntry(purpose=cl.TRANSFER_PURPOSE, docstatus=2, work_order=None, items=[]),
        ):
            self.assertEqual(cl.issue_for_stock_entry(entry), [])

    def test_a_real_afp_transfer_passes_the_gate(self):
        row = frappe.db.sql(
            """
            SELECT se.name
            FROM `tabStock Entry` se
            JOIN `tabWork Order` wo ON wo.name = se.work_order
            WHERE se.purpose = %(purpose)s AND se.docstatus = 1
              AND wo.custom_type = %(afp)s
            LIMIT 1
            """,
            {"purpose": cl.TRANSFER_PURPOSE, "afp": cl.AFP_TYPE},
            as_dict=True,
        )
        if not row:
            self.skipTest("no submitted AFP transfer on this site")
        doc = frappe.get_doc("Stock Entry", row[0].name)
        self.assertTrue(cl.is_labelled_transfer(doc))

    def test_a_real_non_afp_transfer_is_rejected(self):
        row = frappe.db.sql(
            """
            SELECT se.name
            FROM `tabStock Entry` se
            JOIN `tabWork Order` wo ON wo.name = se.work_order
            WHERE se.purpose = %(purpose)s AND se.docstatus = 1
              AND (wo.custom_type IS NULL OR wo.custom_type != %(afp)s)
            LIMIT 1
            """,
            {"purpose": cl.TRANSFER_PURPOSE, "afp": cl.AFP_TYPE},
            as_dict=True,
        )
        if not row:
            self.skipTest("no non-AFP transfer on this site")
        doc = frappe.get_doc("Stock Entry", row[0].name)
        self.assertFalse(cl.is_labelled_transfer(doc))


class TestSubmitOrdering(unittest.TestCase):
    def test_labels_are_issued_after_the_afp_check(self):
        """Source-level guard. The AFP check already existed in `on_submit` — it
        just sat four lines *below* the label call, so every transfer was
        labelled before the check could reject it."""
        import inspect

        from upande_scp.serverscripts.spray_plan_creator import stock_entry_state

        src = inspect.getsource(stock_entry_state.on_submit)
        self.assertLess(
            src.index("custom_type"),
            src.index("issue_for_stock_entry"),
            "the AFP check must precede label minting",
        )


class TestSprayStockEntryTypes(unittest.TestCase):
    """A fresh install marks every patch as done without running it, so the
    seed-data patch for these produced nothing and approve_and_forward could not
    set `stock_entry_type` at all."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        sst.ensure_spray_stock_entry_types()

    def test_all_four_types_exist(self):
        missing = [
            name
            for name in sst.SPRAY_STOCK_ENTRY_TYPES
            if not frappe.db.exists("Stock Entry Type", name)
        ]
        self.assertEqual(missing, [])

    def test_each_type_carries_the_purpose_dispatch_relies_on(self):
        for name, purpose in sst.SPRAY_STOCK_ENTRY_TYPES.items():
            self.assertEqual(
                frappe.db.get_value("Stock Entry Type", name, "purpose"),
                purpose,
                f"{name} has the wrong purpose",
            )

    def test_the_transfer_type_is_the_one_approval_sets(self):
        from upande_scp.serverscripts.spray_plan_ops import spray_plan_approval

        self.assertTrue(
            frappe.db.exists("Stock Entry Type", spray_plan_approval.SE_TYPE_TRANSFER)
        )

    def test_running_twice_is_a_no_op(self):
        before = frappe.db.count("Stock Entry Type")
        sst.ensure_spray_stock_entry_types()
        self.assertEqual(frappe.db.count("Stock Entry Type"), before)
