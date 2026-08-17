"""End to end: a real plan through the whole offline chain, on real stock.

The seam no unit test can cover. Everything else about this feature is tested in pieces —
the ledger mechanics, the guard, the clamping, the handset's arithmetic — but nothing had
put one plan through **scan → mix → spray → sync** and checked what actually landed in the
ledger.

What it proves, or fails trying:

1. `sync_spray_session` accepts the payload the mobile client builds — the same field names,
   nothing renamed on the way;
2. the **Manufacture posts on the mix date**, not today;
3. the **Material Issue posts on the spray's end date**, not today — this is the entry that
   debits the greenhouse, so it decides which month carries the cost;
4. the Issue lands **after** the Manufacture in the ledger, so nothing is consumed before it
   exists;
5. the plan reaches `Completed` and the token records the documents it created;
6. a **re-sync returns the same documents** rather than making more.

## This test writes real stock movements

It consumes a real chemical out of a real CSU and produces a real tank mix into a real
greenhouse, because that is the only way to test the thing. Teardown reverses the chain in
the order ERPNext allows — Issue, then Manufacture — and restores the plan's state, the same
unwind `3r_reverse_issue_manufactured_console.py` performs by hand.

It **skips rather than improvising** when the site has no plan with chemicals genuinely in
its CSU. A test that fabricates its own transfer would be testing the fabrication.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_offline_session_e2e
"""

import unittest

import frappe
from frappe.utils import add_to_date, flt, get_datetime, getdate, now_datetime

from upande_scp.serverscripts.spray_plan_creator import offline_session as OS
from upande_scp.serverscripts.spray_plan_creator import spray_session as SS

#: How far back the pretend session sits. Two days: comfortably backdated, comfortably
#: inside `MAX_AGE_DAYS`, and on a different calendar day from the sync so "posted on the
#: spray date, not today" is a visible difference rather than a subtle one.
SESSION_DAYS_AGO = 2

TOKEN_ID = "_test-e2e-offline-session"


def _candidate():
    """A plan in Chemical Issued whose chemicals are provably in its CSU.

    Read from the ledger rather than from the workflow state: on this site the state was
    backfilled onto plans that never had a transfer, so "Chemical Issued" alone does not
    mean the stock is there.
    """
    rows = frappe.db.sql(
        """SELECT wo.name, wo.wip_warehouse, wo.custom_greenhouse, wo.production_item
           FROM `tabWork Order` wo
           JOIN `tabStock Entry` se
             ON se.work_order = wo.name
            AND se.purpose = 'Material Transfer for Manufacture'
            AND se.docstatus = 1
           WHERE wo.custom_type = %s AND wo.workflow_state = 'Chemical Issued'
             AND wo.wip_warehouse IS NOT NULL
           GROUP BY wo.name
           ORDER BY wo.creation DESC""",
        (OS.AFP_TYPE,),
        as_dict=True,
    )
    for row in rows:
        wo = frappe.get_doc("Work Order", row.name)
        if not wo.required_items:
            continue
        short = False
        for item in wo.required_items:
            have = flt(
                frappe.db.get_value(
                    "Bin",
                    {"item_code": item.item_code, "warehouse": wo.wip_warehouse},
                    "actual_qty",
                )
            )
            if have + 0.0001 < flt(item.required_qty):
                short = True
                break
        if not short:
            return wo
    return None


class TestOfflineSessionEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.wo = _candidate()
        if not cls.wo:
            raise unittest.SkipTest(
                "no plan on this site has its chemicals in the CSU; nothing to run "
                "end-to-end against"
            )
        cls.wo_name = cls.wo.name
        cls.original_state = cls.wo.workflow_state
        cls.created: dict = {}
        # Everything this run creates is stamped after this moment. Teardown works off
        # that rather than off `created`, because an assertion that fails before the
        # documents are captured would otherwise leave them behind — which is exactly
        # what happened the first time: an uncaptured Material Issue blocked the
        # Manufacture's cancellation and left a real tank mix in a real greenhouse.
        cls.run_started = now_datetime()

        # The pretend session: mix, spray, finish — all two days ago.
        base = add_to_date(now_datetime(), days=-SESSION_DAYS_AGO)
        cls.mix_at = base.replace(hour=6, minute=30, second=0, microsecond=0)
        cls.started_at = base.replace(hour=6, minute=45, second=0, microsecond=0)
        cls.ended_at = base.replace(hour=8, minute=15, second=0, microsecond=0)

    @classmethod
    def tearDownClass(cls):
        """Unwind the chain, then put the plan back.

        Issue before Manufacture: ERPNext refuses to cancel a production a later
        consumption still depends on.
        """
        if not getattr(cls, "wo_name", None):
            return
        # Consumption before production, and found from the ledger rather than from
        # `cls.created`: ERPNext refuses to cancel a production that a later consumption
        # still depends on, so a missed Issue strands its Manufacture.
        rows = frappe.db.sql(
            """SELECT DISTINCT sed.parent, sed.s_warehouse, se.purpose
               FROM `tabStock Entry Detail` sed
               JOIN `tabStock Entry` se ON se.name = sed.parent
               WHERE se.docstatus = 1 AND se.creation >= %s
                 AND se.purpose IN ('Manufacture', 'Material Issue')""",
            (cls.run_started,),
            as_dict=True,
        )
        consuming = [r.parent for r in rows if r.purpose == "Material Issue"]
        producing = [r.parent for r in rows if r.purpose == "Manufacture"]
        for name in consuming + producing:
            if not frappe.db.exists("Stock Entry", name):
                continue
            try:
                doc = frappe.get_doc("Stock Entry", name)
                if doc.docstatus == 1:
                    doc.flags.ignore_permissions = True
                    doc.cancel()
                    frappe.db.commit()
            except Exception:
                frappe.db.rollback()
                print(f"\n  NOTE: could not cancel {name}; left for manual cleanup")

        sal = cls.created.get("sal") or frappe.db.get_value(
            "Work Order", cls.wo_name, "custom_spray_application_logsheet"
        )
        if sal and frappe.db.exists("Spray Application Logsheet", sal):
            try:
                doc = frappe.get_doc("Spray Application Logsheet", sal)
                if doc.docstatus == 1:
                    doc.flags.ignore_permissions = True
                    doc.cancel()
                frappe.delete_doc(
                    "Spray Application Logsheet", sal, force=True,
                    ignore_permissions=True,
                )
            except Exception:
                frappe.db.rollback()

        for sms in frappe.get_all(
            "Sprayer Movement Session",
            filters={"work_order": cls.wo_name},
            pluck="name",
        ):
            try:
                frappe.delete_doc(
                    "Sprayer Movement Session", sms, force=True,
                    ignore_permissions=True,
                )
            except Exception:
                frappe.db.rollback()

        if frappe.db.exists(OS.TOKEN, TOKEN_ID):
            frappe.delete_doc(OS.TOKEN, TOKEN_ID, force=True, ignore_permissions=True)

        frappe.db.set_value(
            "Work Order", cls.wo_name,
            {
                "workflow_state": cls.original_state,
                "custom_spray_application_logsheet": None,
                "actual_start_date": None,
                "actual_end_date": None,
            },
            update_modified=False,
        )
        for scan in frappe.get_all(
            "Work Order Chemical Scan",
            filters={"parent": cls.wo_name, "parenttype": "Work Order"},
            pluck="name",
        ):
            frappe.db.delete("Work Order Chemical Scan", {"name": scan})
        frappe.db.commit()

    def _payload(self):
        """Exactly what `spraySession.toPayload()` builds on the handset.

        Written out by hand rather than imported, so a rename on either side shows up here
        as a failure instead of quietly agreeing with itself.
        """
        return {
            "token": TOKEN_ID,
            "work_order": self.wo_name,
            "mix_at": str(self.mix_at),
            "started_at": str(self.started_at),
            "ended_at": str(self.ended_at),
            "device_skew_seconds": -45,
            "scans": [
                {
                    "item_code": row.item_code,
                    "code": None,
                    "scanned_at": str(add_to_date(self.mix_at, minutes=-10)),
                    "qty": flt(row.required_qty),
                }
                for row in self.wo.required_items
            ],
        }

    # ── 1. the guard agrees the session is postable ─────────────────

    def test_1_preflight_accepts_a_well_formed_session(self):
        out = OS.preflight(self._payload())
        self.assertTrue(
            out["ok"],
            f"preflight refused a session it should accept: {out['problems']}",
        )
        self.assertTrue(out["anchor"], "no transfer anchor was resolved")

    # ── 2. the sync itself ──────────────────────────────────────────

    def test_2_sync_applies_the_session(self):
        result = OS.sync_spray_session(self._payload())
        type(self).created = {
            "manufacture": result.get("manufacture_stock_entry"),
            "issue": result.get("issue_stock_entry"),
            "sal": result.get("logsheet"),
        }
        self.assertEqual(result["status"], "Synced", f"sync did not complete: {result}")
        self.assertTrue(result["manufacture_stock_entry"], "no Manufacture was created")
        self.assertTrue(result["issue_stock_entry"], "no Material Issue was created")

    def test_3_the_plan_reached_completed(self):
        self.assertEqual(
            frappe.db.get_value("Work Order", self.wo_name, "workflow_state"),
            SS.STATE_COMPLETED,
        )

    # ── 3. the dates: the whole point of the exercise ───────────────

    def test_4_the_manufacture_posted_on_the_mix_date_not_today(self):
        name = self.created.get("manufacture")
        if not name:
            self.skipTest("no manufacture to check")
        posted = frappe.db.get_value("Stock Entry", name, "posting_date")
        self.assertEqual(
            getdate(posted), getdate(self.mix_at),
            "the tank mix was posted on the sync date instead of the day it was made",
        )
        self.assertNotEqual(
            getdate(posted), getdate(now_datetime()),
            "posting date equals today — backdating did not take effect",
        )

    def test_5_the_issue_posted_on_the_spray_date_not_today(self):
        """The entry that decides which month carries the chemical cost."""
        name = self.created.get("issue")
        if not name:
            self.skipTest("no issue to check")
        posted = frappe.db.get_value("Stock Entry", name, "posting_date")
        self.assertEqual(getdate(posted), getdate(self.ended_at))
        self.assertNotEqual(getdate(posted), getdate(now_datetime()))

    def test_6_the_issue_is_after_the_manufacture_in_the_ledger(self):
        """Nothing consumed before it existed — checked on the ledger's own ordering, not
        on the documents' creation order."""
        manu, issue = self.created.get("manufacture"), self.created.get("issue")
        if not (manu and issue):
            self.skipTest("both entries needed")
        rows = frappe.db.sql(
            """SELECT voucher_no, MIN(posting_datetime) AS at
               FROM `tabStock Ledger Entry`
               WHERE voucher_no IN (%s, %s) AND is_cancelled = 0
               GROUP BY voucher_no"""
            % ("%s", "%s"),
            (manu, issue),
            as_dict=True,
        )
        at = {r.voucher_no: r.at for r in rows}
        self.assertIn(manu, at, "the manufacture left no ledger entry")
        self.assertIn(issue, at, "the issue left no ledger entry")
        self.assertLess(
            at[manu], at[issue],
            "the issue is dated before the manufacture in the ledger",
        )

    def test_7_the_issue_carries_a_real_cost(self):
        """A costless spray would defeat the reason for dating it at all."""
        name = self.created.get("issue")
        if not name:
            self.skipTest("no issue to check")
        total = flt(
            frappe.db.get_value("Stock Entry", name, "total_outgoing_value")
        ) or sum(
            flt(r.amount)
            for r in frappe.get_all(
                "Stock Entry Detail", filters={"parent": name}, fields=["amount"]
            )
        )
        self.assertGreater(total, 0, "the tank mix was issued at zero value")

    # ── 4. what the token recorded, and re-syncing ──────────────────

    def test_8_the_token_records_what_it_created(self):
        row = frappe.db.get_value(
            OS.TOKEN, TOKEN_ID,
            ["status", "manufacture_stock_entry", "issue_stock_entry", "logsheet",
             "device_skew_seconds", "mix_at", "ended_at"],
            as_dict=True,
        )
        self.assertIsNotNone(row, "the token was not recorded")
        self.assertEqual(row.status, "Synced")
        self.assertEqual(row.manufacture_stock_entry, self.created.get("manufacture"))
        self.assertEqual(row.issue_stock_entry, self.created.get("issue"))
        self.assertEqual(
            row.device_skew_seconds, -45,
            "the device's clock skew was not carried through for audit",
        )

    def test_9_a_re_sync_returns_the_same_documents(self):
        """The idempotency guarantee, on the real chain: pressing Send twice must not
        produce a second Manufacture and a second Issue."""
        before = frappe.db.count(
            "Stock Entry", {"work_order": self.wo_name, "docstatus": 1}
        )
        again = OS.sync_spray_session(self._payload())
        after = frappe.db.count(
            "Stock Entry", {"work_order": self.wo_name, "docstatus": 1}
        )
        self.assertTrue(again["already_synced"])
        self.assertEqual(after, before, "a re-sync created more stock entries")
        self.assertEqual(again["manufacture_stock_entry"], self.created.get("manufacture"))

    def test_a_the_logsheet_carries_a_dated_stop_time(self):
        """Named `test_a_` so it runs after test_9 — the suite is alphabetical.

        The `Time` fields alone cannot say which day a session ended, which is exactly the
        gap that made an offline session unreconstructable.
        """
        sal = self.created.get("sal")
        if not sal:
            self.skipTest("no logsheet to check")
        stop_at = frappe.db.get_value(
            "Spray Application Logsheet", sal, "custom_application_stop_at"
        )
        if stop_at is None:
            self.skipTest("this site's logsheet has no datetime field yet")
        self.assertEqual(getdate(stop_at), getdate(self.ended_at))
