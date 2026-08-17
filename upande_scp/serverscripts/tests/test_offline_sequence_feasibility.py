"""Feasibility probe: can an offline token sync issue stock that was never made?

The worry is real but sits in a different place than "Issue without Manufacture". Two
distinct failures, and they need different answers:

**A. Issue with no Manufacture at all.** Prevented by the state machine, which these
tests exercise through the real endpoints rather than by reading the code.

**B. Issue posted EARLIER in the stock ledger than its Manufacture.** This is the one
backdating introduces: both documents exist, in the right order of creation, but with
posting times that put the consumption before the production. ERPNext judges stock by
*posting* time, not creation order, so document order proves nothing here. Tested by
posting a real pair out of order and seeing what happens.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_offline_sequence_feasibility
"""

import unittest

import frappe
from erpnext.stock.stock_ledger import NegativeStockError
from frappe.utils import add_to_date, now_datetime

from upande_scp.serverscripts.spray_plan_creator import spray_session as SS

ITEM = "_TEST-OFFLINE-MIX"


def _company_warehouse():
    """A real, non-group warehouse with a company that has stock accounts."""
    row = frappe.db.sql(
        """SELECT w.name, w.company FROM tabWarehouse w
           WHERE w.is_group = 0 AND w.disabled = 0
             AND w.name LIKE 'Chemical Store%' AND w.company IS NOT NULL
           LIMIT 1""",
        as_dict=True,
    )
    return (row[0]["name"], row[0]["company"]) if row else (None, None)


class TestStateMachineGuards(unittest.TestCase):
    """Failure A, through the endpoints an offline sync would actually call."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_a_spray_cannot_start_unless_the_tank_mix_is_made(self):
        """The first gate. A token replaying `start` before `manufacture` is refused —
        the client cannot talk the server past this by ordering its queue wrongly."""
        wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": "Application Floor Plan",
             "workflow_state": ("in", ["Approved", "Chemical Issued"])},
            "name",
        )
        if not wo:
            self.skipTest("no pre-manufacture AFP work order on this site")
        with self.assertRaises(frappe.ValidationError) as cm:
            SS.start_spray_session(wo)
        self.assertIn("expected", str(cm.exception))
        self.assertIn(SS.STATE_TANK_MIX_MANUFACTURED, str(cm.exception))

    def test_a_spray_cannot_end_unless_it_started(self):
        wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": "Application Floor Plan",
             "workflow_state": SS.STATE_TANK_MIX_MANUFACTURED},
            "name",
        )
        if not wo:
            self.skipTest("no manufactured-but-unstarted AFP work order")
        with self.assertRaises(frappe.ValidationError) as cm:
            SS.end_spray_session(wo)
        self.assertIn(SS.STATE_SPRAYING_IN_PROGRESS, str(cm.exception))

    def test_ending_requires_a_submitted_manufacture_entry_on_file(self):
        """`end_spray_session` looks the Manufacture SE up and throws when absent, so
        the Material Issue is never built from nothing. Verified on the lookup itself:
        for a plan that never manufactured, there is nothing to find."""
        wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": "Application Floor Plan",
             "workflow_state": ("in", ["Awaiting Approval", "Approved"])},
            "name",
        )
        if not wo:
            self.skipTest("no pre-manufacture AFP work order on this site")
        self.assertIsNone(
            SS._find_submitted_manufacture_se(wo),
            "a plan that never manufactured must have no Manufacture SE to issue against",
        )

    def test_the_ordering_is_a_server_invariant_not_a_client_convention(self):
        """Stated as a test so it cannot quietly stop being true: every route into the
        spray flow checks the state it requires, so a replayed log cannot skip a step."""
        self.assertEqual(SS.STATE_TANK_MIX_MANUFACTURED, "Tank Mix Manufactured")
        self.assertEqual(SS.STATE_SPRAYING_IN_PROGRESS, "Spraying In Progress")
        import inspect

        start_src = inspect.getsource(SS.start_spray_session)
        end_src = inspect.getsource(SS.end_spray_session)
        self.assertIn("STATE_TANK_MIX_MANUFACTURED", start_src)
        self.assertIn("STATE_SPRAYING_IN_PROGRESS", end_src)
        self.assertIn("_find_submitted_manufacture_se", end_src)


class TestBackdatedLedgerOrder(unittest.TestCase):
    """Failure B — the one an offline token sync would actually introduce.

    Both documents exist and are created in the right order, but their *posting* times
    put the consumption before the production. ERPNext judges stock by posting time, so
    creation order is no defence. This posts a real pair out of order to find out what
    the ledger does about it.
    """

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.warehouse, cls.company = _company_warehouse()
        if not cls.warehouse:
            raise unittest.SkipTest("no usable warehouse on this site")
        cls.made: list[str] = []

        group = frappe.db.get_value("Item Group", {"is_group": 0}, "name")
        if not frappe.db.exists("Item", ITEM):
            frappe.get_doc({
                "doctype": "Item", "item_code": ITEM, "item_name": ITEM,
                "item_group": group, "stock_uom": "Litre", "is_stock_item": 1,
            }).insert(ignore_permissions=True)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        """Unwind every movement of the test item, issues before receipts.

        Not `reversed(cls.made)`: ERPNext refuses to cancel a receipt that a *later*
        issue still depends on — which is the same protection this class is testing,
        showing up from the other side. So all consumption is cancelled first, putting
        the stock back, and only then the receipts.

        Driven off the ledger rather than off `cls.made` so residue from an earlier run
        that died mid-teardown is cleaned up too.
        """
        rows = frappe.db.sql(
            """SELECT DISTINCT sed.parent, sed.s_warehouse
               FROM `tabStock Entry Detail` sed
               JOIN `tabStock Entry` se ON se.name = sed.parent
               WHERE sed.item_code = %s AND se.docstatus = 1""",
            (ITEM,),
            as_dict=True,
        )
        issues = [r.parent for r in rows if r.s_warehouse]
        receipts = [r.parent for r in rows if not r.s_warehouse]
        for name in issues + receipts:
            if not frappe.db.exists("Stock Entry", name):
                continue
            doc = frappe.get_doc("Stock Entry", name)
            if doc.docstatus != 1:
                continue
            try:
                doc.flags.ignore_permissions = True
                doc.cancel()
                frappe.db.commit()
            except Exception:
                frappe.db.rollback()
                print(f"\n  NOTE: could not cancel {name}; left for manual cleanup")
        frappe.db.commit()
        if frappe.db.exists("Item", ITEM):
            # Disabled rather than deleted: cancelled ledger entries still reference it,
            # and disabling takes it out of every picker just the same.
            frappe.db.set_value("Item", ITEM, "disabled", 1, update_modified=False)
        frappe.db.commit()

    def _post(self, purpose: str, qty: float, when, expect_ok=True):
        """Post a stock movement at an explicit moment, the way a synced token would."""
        payload = {
            "doctype": "Stock Entry",
            "stock_entry_type": (
                "Material Receipt" if purpose == "Material Receipt" else "Material Issue"
            ),
            "purpose": purpose,
            "company": self.company,
            "posting_date": when.date().isoformat(),
            "posting_time": when.time().isoformat(),
            "set_posting_time": 1,
            "items": [{
                "item_code": ITEM,
                "qty": qty,
                "uom": "Litre",
                "stock_uom": "Litre",
                "conversion_factor": 1,
                ("t_warehouse" if purpose == "Material Receipt" else "s_warehouse"): (
                    self.warehouse
                ),
                "basic_rate": 10,
            }],
        }
        doc = frappe.get_doc(payload)
        doc.flags.ignore_permissions = True
        doc.flags.ignore_links = True
        doc.insert()
        doc.submit()
        self.made.append(doc.name)
        return doc

    def test_stock_cannot_be_issued_before_it_was_produced(self):
        """**The feasibility answer.** Produce at T, then try to consume at T minus an
        hour — the mix did not exist yet at that moment.

        If this passes, a token synced with its times out of order fails loudly instead
        of issuing chemical that was never made.
        """
        produced_at = add_to_date(now_datetime(), hours=-2)
        self._post("Material Receipt", 10, produced_at)

        before_it_existed = add_to_date(produced_at, hours=-1)
        # Asserted on the exception TYPE, not its wording: ERPNext's refusal reads
        # "N units of item X needed in warehouse Y to complete this transaction",
        # which contains none of the words a keyword check would look for.
        with self.assertRaises(NegativeStockError) as cm:
            self._post("Material Issue", 10, before_it_existed)
        self.assertIn(ITEM.lower(), str(cm.exception).lower())

    def test_the_same_pair_in_the_right_order_posts_cleanly(self):
        """The control. Same documents, same quantities — only the posting times differ,
        which is the whole point: the ledger is judged on time, not creation order."""
        produced_at = add_to_date(now_datetime(), hours=-2)
        self._post("Material Receipt", 7, produced_at)
        issued_at = add_to_date(produced_at, hours=1)
        issue = self._post("Material Issue", 7, issued_at)
        self.assertEqual(issue.docstatus, 1)

    def test_negative_stock_is_off_which_is_what_makes_that_refusal_reliable(self):
        """The guarantee rests on a setting, so the setting is asserted. With
        `allow_negative_stock` on, an out-of-order sync would silently create phantom
        consumption instead of failing."""
        self.assertFalse(
            bool(frappe.db.get_single_value("Stock Settings", "allow_negative_stock")),
            "allow_negative_stock is ON — a backdated Issue could post against stock "
            "that did not exist yet",
        )

    def test_a_backdated_post_is_permitted_at_all(self):
        """The other half of feasibility: backdating has to *work* for the token design,
        not just be safe. If a role restriction were set, the sync user would need it."""
        restricted = frappe.db.get_single_value(
            "Stock Settings", "role_allowed_to_create_edit_back_dated_transactions"
        )
        produced_at = add_to_date(now_datetime(), hours=-3)
        entry = self._post("Material Receipt", 1, produced_at)
        self.assertEqual(str(entry.posting_date), str(produced_at.date()))
        if restricted:
            print(
                f"\n  NOTE: back-dated posting is limited to role {restricted!r}; "
                "the sync user must hold it."
            )
