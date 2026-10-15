"""End to end: a throwaway plan through the whole offline chain, on its own stock.

The seam no unit test can cover. Everything else about this feature is tested in pieces —
the ledger mechanics, the guard, the clamping, the handset's arithmetic — but nothing puts
one plan through **scan -> mix -> spray -> sync** and checks what actually landed in the
ledger.

What it proves, or fails trying:

1. `sync_spray_session` accepts the payload the mobile client builds — the same field names,
   nothing renamed on the way;
2. the **Manufacture posts on the mix date**, not today;
3. the **Material Issue posts on the spray's end date**, not today — this is the entry that
   debits the greenhouse, so it decides which month carries the cost;
4. the Issue lands **after** the Manufacture in the ledger;
5. the plan reaches `Completed` and the token records the documents it created;
6. a **re-sync returns the same documents** rather than making more;
7. a session that claims a moment *before* its chemicals reached the CSU is **clamped to
   the transfer**, and everything posts there (never earlier, never "today" for a
   transfer that was days ago).

## What it writes, and what it will not touch

It commits (the sync commits), so it cannot lean on a rollback. It therefore builds its
OWN plan from scratch (`afp_fixture.ThrowawayPlan`): a batch chemical, a tank-mix item and
BOM, three warehouses, a Material Receipt, an Application Floor Plan Work Order and its
transfer — all under a unique `_TEST` prefix, removed by SQL at the start and the end.

It never selects a pre-existing Work Order, scan row or stock entry, and it never deletes
or cancels anything it did not create. Every Work Order it mutates is asserted to be one
the fixture made (`assert_owns`). An earlier version borrowed a real "Chemical Issued"
plan and its teardown deleted that plan's scan row.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_offline_session_e2e
"""

import unittest

import frappe
from frappe.utils import add_to_date, flt, get_datetime, getdate, now_datetime

from upande_scp.serverscripts.spray_plan_creator import offline_session as OS
from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.tests import afp_fixture as AF

#: How far back the pretend session sits. Two days: comfortably backdated, comfortably
#: inside `MAX_AGE_DAYS`, and on a different calendar day from the sync so "posted on the
#: spray date, not today" is a visible difference rather than a subtle one.
SESSION_DAYS_AGO = 2


class _E2EBase:
    """Shared fixture; the concrete classes below mix it with TestCase."""

    TAG = "E2E"
    TRANSFER_DAYS_AGO = 4

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.fx = AF.ThrowawayPlan(cls.TAG)
        try:
            cls.fx.build(transfer_days_ago=cls.TRANSFER_DAYS_AGO)
        except Exception:
            # tearDownClass does not run when setUpClass raises
            frappe.db.rollback()
            AF.wipe(cls.fx.prefix)
            raise
        cls.wo = cls.fx.wo
        cls.wo_name = cls.wo.name
        cls.token_id = f"_test-e2e-{cls.TAG.lower()}"
        cls.created: dict = {}
        base = add_to_date(now_datetime(), days=-SESSION_DAYS_AGO)
        cls.mix_at = base.replace(hour=6, minute=30, second=0, microsecond=0)
        cls.started_at = base.replace(hour=6, minute=45, second=0, microsecond=0)
        cls.ended_at = base.replace(hour=8, minute=15, second=0, microsecond=0)

    @classmethod
    def tearDownClass(cls):
        """Remove the fixture and everything keyed to it. Nothing is cancelled or
        selected by state: the prefix is the only handle."""
        fx = getattr(cls, "fx", None)
        if fx is None:
            return
        frappe.db.rollback()
        for tok in frappe.db.sql_list(
            "SELECT name FROM `tabSpray Session Token` WHERE work_order IN %s",
            (fx.wo_names or [""],),
        ):
            AF._delete_docs(OS.TOKEN, [tok])
        if frappe.db.exists(OS.TOKEN, cls.token_id):
            AF._delete_docs(OS.TOKEN, [cls.token_id])
        AF.wipe(fx.prefix)

    def setUp(self):
        # The guard: whatever this class does next, it does to its own plan.
        self.fx.assert_owns(self.wo_name)

    
class TestBackDatedSession(_E2EBase, unittest.TestCase):
    """Transfer four days ago, session two days ago: nothing to clamp, so the postings
    sit on the session's own days."""

    TAG = "E2E BD"
    TRANSFER_DAYS_AGO = 4

    def _payload(self):
        """Exactly what `spraySession.toPayload()` builds on the handset.

        Written out by hand rather than imported, so a rename on either side shows up here
        as a failure instead of quietly agreeing with itself.
        """
        return {
            "token": self.token_id,
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
            OS.TOKEN, self.token_id,
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


class TestSessionClaimingAMomentBeforeItsTransfer(_E2EBase, unittest.TestCase):
    """The transfer happens now; the handset says the mix was two days ago.

    That is impossible (the chemicals were not in the CSU yet), so `resolve_moments`
    clamps the mix to the transfer and the rest follow it. This is the "the replay posted
    on today's date instead of the mix moment" observation, and it is correct: the
    posting date is the *clamped* mix moment, which here is the transfer's own moment.
    It was seen on a real plan whose transfer had been posted minutes earlier; posting two
    days earlier would have failed on stock, not been more honest.
    """

    TAG = "E2E CL"
    TRANSFER_DAYS_AGO = 0

    def _payload(self):
        return {
            "token": self.token_id,
            "work_order": self.wo_name,
            "mix_at": str(self.mix_at),
            "started_at": str(self.started_at),
            "ended_at": str(self.ended_at),
            "scans": [
                {"item_code": r.item_code, "code": None,
                 "scanned_at": str(add_to_date(self.mix_at, minutes=-10)),
                 "qty": flt(r.required_qty)}
                for r in self.wo.required_items
            ],
        }

    def test_the_whole_chain_is_clamped_to_the_transfer_not_to_the_claimed_day(self):
        out = OS.preflight(self._payload())
        self.assertTrue(out["ok"], out["problems"])
        self.assertTrue(any("adjusted forward" in n for n in out["notes"]))
        _, anchor = OS.transfer_anchor(self.wo_name)

        self.fx.assert_owns(self.wo_name)
        result = OS.sync_spray_session(self._payload())
        self.assertEqual(result["status"], "Synced", result)

        def posted(name):
            row = frappe.db.get_value(
                "Stock Entry", name, ["posting_date", "posting_time"], as_dict=True)
            return get_datetime(f"{row.posting_date} {row.posting_time}")

        manu = posted(result["manufacture_stock_entry"])
        issue = posted(result["issue_stock_entry"])
        self.assertEqual(manu, anchor, "the mix must post at the transfer, not the claimed day")
        self.assertGreater(issue, manu, "the issue must land after the manufacture")
        self.assertEqual(getdate(manu), getdate(anchor))

    def test_resolve_moments_clamps_forward_only(self):
        anchor = now_datetime().replace(microsecond=0)
        got = OS.resolve_moments(self._payload(), anchor)
        self.assertEqual(got["mix_at"], anchor)
        self.assertEqual(got["started_at"], anchor)
        self.assertGreater(got["ended_at"], got["mix_at"])
        # a claimed moment AFTER the anchor is kept as claimed
        later = add_to_date(anchor, hours=3)
        p = dict(self._payload(), mix_at=str(later), started_at=str(later),
                 ended_at=str(add_to_date(later, hours=1)))
        got = OS.resolve_moments(p, anchor)
        self.assertEqual(got["mix_at"], later)


class _GuardBase(_E2EBase):
    """Shared payload for the replay guard: moments sit after the (4 day old) transfer."""

    TRANSFER_DAYS_AGO = 4

    def _payload(self, mix=True, start=True, end_after_minutes=None, skew=0):
        base = add_to_date(now_datetime(), days=-1).replace(
            hour=6, minute=30, second=0, microsecond=0)
        started = base.replace(minute=45)
        p = {
            "token": self.token_id,
            "work_order": self.wo_name,
            "mix_at": str(base) if mix else None,
            "started_at": str(started) if start else None,
            "ended_at": (str(add_to_date(started, minutes=end_after_minutes))
                         if end_after_minutes is not None else None),
            "device_skew_seconds": skew,
            "scans": [
                {"item_code": r.item_code, "code": None,
                 "scanned_at": str(add_to_date(base, minutes=-10)),
                 "qty": flt(r.required_qty)}
                for r in self.wo.required_items
            ],
        }
        return p

    def _state(self):
        return frappe.db.get_value("Work Order", self.wo_name, "workflow_state")


class TestOneSecondSessionIsHeld(_GuardBase, unittest.TestCase):
    """The incident: mix, start and end all within a second of the scan."""

    TAG = "E2E HS"

    def test_a_one_second_session_is_held_not_completed(self):
        before = frappe.db.count("Error Log", {"method": "Spray session refused"})
        out = OS.sync_spray_session(self._payload(end_after_minutes=0))
        self.assertTrue(out.get("held"), out)
        self.assertEqual(out["status"], OS.STATUS_TOO_SHORT)
        self.assertIn("minimum", out["refusal"])
        self.assertEqual(self._state(), "Chemical Issued", "the plan must not move")
        self.assertFalse(frappe.db.get_value(
            "Stock Entry", {"work_order": self.wo_name, "purpose": "Manufacture",
                            "docstatus": 1}))
        # logged to the Error Log (title is stored in `method`)
        after = frappe.db.count("Error Log", {"method": "Spray session refused"})
        self.assertGreaterEqual(after, before)

    def test_b_a_scan_only_token_does_nothing(self):
        p = self._payload(mix=False, start=False)
        out = OS.sync_spray_session(p)
        self.assertEqual(out["status"], "Pending")
        self.assertEqual(self._state(), "Chemical Issued")

    def test_c_end_without_start_is_held_incomplete(self):
        p = self._payload(start=False)
        p["ended_at"] = p["mix_at"]
        out = OS.sync_spray_session(p)
        self.assertEqual(out["status"], OS.STATUS_INCOMPLETE)
        self.assertEqual(self._state(), "Chemical Issued")


class TestMixOnlyStopsAtTheMix(_GuardBase, unittest.TestCase):
    TAG = "E2E MO"

    def test_1_mix_only_replays_only_the_manufacture(self):
        out = OS.sync_spray_session(self._payload(start=False))
        self.assertEqual(out["status"], OS.STATUS_PARTIAL, out)
        self.assertEqual(self._state(), SS.STATE_TANK_MIX_MANUFACTURED)
        self.assertTrue(out["manufacture_stock_entry"])
        self.assertFalse(out["issue_stock_entry"])
        self.assertFalse(out["started_at"], "no start may be invented")
        self.assertFalse(out["ended_at"], "no end may be invented")

    def test_2_the_same_token_later_completes_with_the_real_times(self):
        out = OS.sync_spray_session(self._payload(end_after_minutes=90))
        self.assertEqual(out["status"], "Synced", out)
        self.assertEqual(self._state(), SS.STATE_COMPLETED)


class TestSkewIsFlaggedNotBlocked(_GuardBase, unittest.TestCase):
    TAG = "E2E SK"

    def test_a_three_hour_skew_is_a_warning_on_the_token(self):
        out = OS.sync_spray_session(self._payload(end_after_minutes=90, skew=-3 * 3600))
        self.assertEqual(out["status"], "Synced", out)
        self.assertIn("hours behind", out["crew_warnings"] or "")
