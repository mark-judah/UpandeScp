"""Syncing an offline spray session: the guard, the clamping, and idempotency.

The mechanics these rely on are already established in
`test_offline_token_mechanics.py` (the ledger refuses out-of-order posting; the transfer
date is a real anchor floor; backdating carries cost and defers valuation). This file
tests the layer built on top: whether the sync reaches the right conclusions **before**
touching stock, and whether a re-sync is safe.

What matters most here:

* **a wrong device clock can only push a posting later.** `resolve_moments` clamps to the
  transfer anchor, so the ledger's refusal becomes a backstop rather than the mechanism.
* **the guard speaks about chemicals and dates**, not warehouses and stock errors.
* **a re-sync returns what the first one made.** The handset's own id cannot carry that,
  because it does not survive a reinstall.
* **a refused session is still recorded.** It happened in the field; the reason it could
  not be applied is worth more than a clean table.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_offline_session
"""

import unittest

import frappe
from frappe.utils import add_to_date, get_datetime, now_datetime

from upande_scp.serverscripts.spray_plan_creator import offline_session as OS


class TestServerClock(unittest.TestCase):
    """What the handset measures its skew against."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_it_reports_both_clocks_and_the_zone(self):
        out = OS.server_clock()
        for key in ("server_now", "utc_now", "timezone"):
            self.assertTrue(out.get(key), f"{key} missing")

    def test_the_two_clocks_differ_by_the_site_offset(self):
        """The skew calculation is only meaningful if the server reports honestly."""
        from upande_scp.serverscripts.common.timezone import offset_minutes

        out = OS.server_clock()
        delta = (
            get_datetime(out["server_now"]) - get_datetime(out["utc_now"])
        ).total_seconds() / 60
        expected = offset_minutes(out["timezone"]) or 0
        self.assertAlmostEqual(delta, expected, delta=2)


class TestMomentClamping(unittest.TestCase):
    """The heart of it: a bad clock must not be able to reach behind the anchor.

    Pure arithmetic, no site state — so the rule can be read off the test.
    """

    def setUp(self):
        self.anchor = get_datetime("2026-08-17 08:00:00")

    def test_honest_moments_pass_through_untouched(self):
        out = OS.resolve_moments(
            {
                "mix_at": "2026-08-17 09:00:00",
                "started_at": "2026-08-17 09:30:00",
                "ended_at": "2026-08-17 11:00:00",
            },
            self.anchor,
        )
        self.assertEqual(str(out["mix_at"]), "2026-08-17 09:00:00")
        self.assertEqual(str(out["started_at"]), "2026-08-17 09:30:00")
        self.assertEqual(str(out["ended_at"]), "2026-08-17 11:00:00")

    def test_a_mix_claimed_before_its_chemicals_arrived_is_pushed_to_the_anchor(self):
        """The clock-skew defence. A device two hours behind cannot post a mix before the
        transfer that delivered its inputs."""
        out = OS.resolve_moments({"mix_at": "2026-08-17 06:00:00"}, self.anchor)
        self.assertEqual(out["mix_at"], self.anchor)

    def test_a_start_before_the_mix_is_pushed_after_it(self):
        out = OS.resolve_moments(
            {"mix_at": "2026-08-17 09:00:00", "started_at": "2026-08-17 08:30:00"},
            self.anchor,
        )
        self.assertGreaterEqual(out["started_at"], out["mix_at"])

    def test_the_end_always_lands_after_the_mix(self):
        """So the Issue can never post before the Manufacture — the failure the whole
        exercise exists to prevent, made impossible by arithmetic rather than caught by
        the ledger."""
        out = OS.resolve_moments(
            {"mix_at": "2026-08-17 09:00:00", "ended_at": "2026-08-17 07:00:00"},
            self.anchor,
        )
        self.assertGreater(out["ended_at"], out["mix_at"])
        self.assertEqual(
            (out["ended_at"] - out["mix_at"]).total_seconds(), OS.ORDER_GAP_SECONDS
        )

    def test_clamping_only_ever_moves_a_moment_later(self):
        """The safety property in one sentence: a wrong clock cannot reach backwards."""
        for claimed in ("2026-08-01 00:00:00", "2026-08-17 07:59:59", "1999-01-01 00:00:00"):
            out = OS.resolve_moments({"mix_at": claimed}, self.anchor)
            self.assertGreaterEqual(out["mix_at"], get_datetime(claimed))
            self.assertGreaterEqual(out["mix_at"], self.anchor)

    def test_missing_moments_fall_back_rather_than_crashing(self):
        out = OS.resolve_moments({}, self.anchor)
        self.assertEqual(out["mix_at"], self.anchor)
        self.assertGreaterEqual(out["ended_at"], out["mix_at"])

    def test_unreadable_moments_are_treated_as_absent(self):
        out = OS.resolve_moments({"mix_at": "not a date"}, self.anchor)
        self.assertEqual(out["mix_at"], self.anchor)

    def test_with_no_anchor_it_still_orders_itself(self):
        """A plan with no transfer is refused by the guard, but the arithmetic must not
        blow up on the way there."""
        out = OS.resolve_moments(
            {"mix_at": "2026-08-17 09:00:00", "ended_at": "2026-08-17 08:00:00"}, None
        )
        self.assertGreater(out["ended_at"], out["mix_at"])


class TestPreflight(unittest.TestCase):
    """The guard, against real plans on this site."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_an_unknown_plan_is_refused_in_words(self):
        out = OS.preflight({"token": "t1", "work_order": "MFG-WO-NOPE-9999"})
        self.assertFalse(out["ok"])
        self.assertIn("does not exist", " ".join(out["problems"]))

    def test_a_plan_with_no_transfer_cannot_be_dated(self):
        """The anchor floor has to come from somewhere. Without a transfer there is no
        honest moment to post the mix at, so the session is refused rather than dated to
        the sync."""
        wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": OS.AFP_TYPE, "workflow_state": "Awaiting Approval"},
            "name",
        )
        if not wo:
            self.skipTest("no pre-transfer plan on this site")
        out = OS.preflight({"token": "t2", "work_order": wo})
        self.assertFalse(out["ok"])
        self.assertIn("transfer", " ".join(out["problems"]).lower())

    def test_a_token_scanning_the_wrong_chemicals_is_refused(self):
        """A token describing different chemicals is describing a different plan."""
        wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": OS.AFP_TYPE, "workflow_state": "Chemical Issued"},
            "name",
        )
        if not wo:
            self.skipTest("no Chemical Issued plan on this site")
        out = OS.preflight({
            "token": "t3", "work_order": wo,
            "scans": [{"item_code": "_TEST-NOT-ON-THIS-PLAN"}],
        })
        self.assertFalse(out["ok"])
        joined = " ".join(out["problems"])
        self.assertTrue(
            "not scanned" in joined or "not on the plan" in joined,
            f"expected a chemical-set complaint, got: {joined}",
        )

    def test_the_guard_names_chemicals_not_warehouses(self):
        """The whole point of pre-flighting: the supervisor reads about chemicals and
        dates, not a NegativeStockError naming a warehouse they have never heard of."""
        wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": OS.AFP_TYPE, "workflow_state": "Chemical Issued"},
            "name",
        )
        if not wo:
            self.skipTest("no Chemical Issued plan on this site")
        doc = frappe.get_doc("Work Order", wo)
        scans = [
            {"item_code": r.item_code} for r in (doc.required_items or []) if r.item_code
        ]
        out = OS.preflight({"token": "t4", "work_order": wo, "scans": scans})
        for problem in out["problems"]:
            self.assertNotIn(
                "NegativeStockError", problem,
                "the guard should explain, not leak the ledger's exception",
            )

    def test_an_ancient_session_is_held_for_a_person(self):
        """Backdating that far can land behind entries that already consumed the stock,
        and re-valuing those is not a sync's decision."""
        # Deterministic pick. `get_value` with no ordering returns whichever row
        # the database offers first, so this test passed or failed depending on
        # what else happened to be in the table — creating one new plan was
        # enough to flip it.
        wo = frappe.db.get_value(
            "Work Order", {"custom_type": OS.AFP_TYPE}, "name", order_by="creation asc"
        )
        if not wo:
            self.skipTest("no AFP plan on this site")
        # Scan every chemical on the plan. Without this the preflight stops at
        # "not scanned: <item>" and never reaches the age check, so the assertion
        # below was testing whichever guard happened to fire first.
        doc = frappe.get_doc("Work Order", wo)
        scans = [
            {"item_code": r.item_code} for r in (doc.required_items or []) if r.item_code
        ]
        ancient = str(add_to_date(now_datetime(), days=-(OS.MAX_AGE_DAYS + 30)))
        out = OS.preflight({
            "token": "t5", "work_order": wo, "scans": scans,
            "mix_at": ancient, "ended_at": ancient,
        })
        self.assertFalse(out["ok"])
        self.assertIn("days old", " ".join(out["problems"]))

    def test_it_reports_when_it_had_to_move_the_times(self):
        """Silent correction would hide a broken device clock; the note makes it visible
        without blocking the sync."""
        wo, anchor = None, None
        for candidate in frappe.get_all(
            "Work Order",
            filters={"custom_type": OS.AFP_TYPE,
                     "workflow_state": ("in", ["Chemical Issued",
                                               "Tank Mix Manufactured", "Completed"])},
            pluck="name", limit_page_length=40,
        ):
            _se, moment = OS.transfer_anchor(candidate)
            if moment:
                wo, anchor = candidate, moment
                break
        if not wo:
            self.skipTest("no plan with a submitted transfer on this site")
        out = OS.preflight({
            "token": "t6", "work_order": wo,
            "mix_at": str(add_to_date(anchor, hours=-5)),
            "ended_at": str(add_to_date(anchor, hours=-4)),
        })
        self.assertIn(
            "adjusted forward", " ".join(out["notes"]),
            "a clamped session must say so",
        )


class TestTokenIdempotency(unittest.TestCase):
    """A re-sync must not create a second set of documents."""

    TOKEN_ID = "_test-token-idem-1"

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def setUp(self):
        if frappe.db.exists(OS.TOKEN, self.TOKEN_ID):
            frappe.delete_doc(OS.TOKEN, self.TOKEN_ID, force=True,
                              ignore_permissions=True)
            frappe.db.commit()

    def tearDown(self):
        if frappe.db.exists(OS.TOKEN, self.TOKEN_ID):
            frappe.delete_doc(OS.TOKEN, self.TOKEN_ID, force=True,
                              ignore_permissions=True)
            frappe.db.commit()

    def test_a_refused_session_is_still_recorded_with_its_reason(self):
        """It happened in the field. The reason it could not be applied is worth more
        than a clean table."""
        wo = frappe.db.get_value("Work Order", {"custom_type": OS.AFP_TYPE}, "name")
        if not wo:
            self.skipTest("no AFP plan on this site")
        ancient = str(add_to_date(now_datetime(), days=-(OS.MAX_AGE_DAYS + 30)))
        with self.assertRaises(frappe.ValidationError):
            OS.sync_spray_session({
                "token": self.TOKEN_ID, "work_order": wo,
                "mix_at": ancient, "ended_at": ancient,
            })
        row = frappe.db.get_value(
            OS.TOKEN, self.TOKEN_ID, ["status", "refusal"], as_dict=True
        )
        self.assertIsNotNone(row, "the token must survive its own refusal")
        self.assertEqual(row.status, "Refused")
        self.assertTrue(row.refusal, "the reason must be recorded, not just the failure")

    def test_the_token_records_the_device_skew_it_was_given(self):
        """So a suspect timestamp is auditable rather than invisible."""
        wo = frappe.db.get_value("Work Order", {"custom_type": OS.AFP_TYPE}, "name")
        if not wo:
            self.skipTest("no AFP plan on this site")
        ancient = str(add_to_date(now_datetime(), days=-(OS.MAX_AGE_DAYS + 30)))
        try:
            OS.sync_spray_session({
                "token": self.TOKEN_ID, "work_order": wo,
                "mix_at": ancient, "ended_at": ancient,
                "device_skew_seconds": -420,
            })
        except frappe.ValidationError:
            pass
        self.assertEqual(
            frappe.db.get_value(OS.TOKEN, self.TOKEN_ID, "device_skew_seconds"), -420
        )

    def test_an_already_synced_token_returns_instead_of_re_posting(self):
        """The idempotency guarantee, exercised on the status the sync checks first."""
        wo = frappe.db.get_value("Work Order", {"custom_type": OS.AFP_TYPE}, "name")
        if not wo:
            self.skipTest("no AFP plan on this site")
        doc = frappe.get_doc({
            "doctype": OS.TOKEN, "token": self.TOKEN_ID, "work_order": wo,
            "status": "Synced",
        })
        doc.flags.ignore_permissions = True
        doc.flags.ignore_links = True
        doc.insert(ignore_permissions=True)
        frappe.db.commit()

        out = OS.sync_spray_session({"token": self.TOKEN_ID, "work_order": wo})
        self.assertTrue(out["already_synced"])
        self.assertEqual(out["status"], "Synced")

    def test_preflight_short_circuits_on_an_already_synced_token(self):
        wo = frappe.db.get_value("Work Order", {"custom_type": OS.AFP_TYPE}, "name")
        if not wo:
            self.skipTest("no AFP plan on this site")
        doc = frappe.get_doc({
            "doctype": OS.TOKEN, "token": self.TOKEN_ID, "work_order": wo,
            "status": "Synced",
        })
        doc.flags.ignore_permissions = True
        doc.flags.ignore_links = True
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        out = OS.preflight({"token": self.TOKEN_ID, "work_order": wo})
        self.assertTrue(out["ok"])
        self.assertTrue(out["already_synced"])

    def test_a_session_needs_a_token_and_a_plan(self):
        with self.assertRaises(frappe.ValidationError):
            OS.sync_spray_session({"work_order": "MFG-WO-2026-00001"})
        with self.assertRaises(frappe.ValidationError):
            OS.sync_spray_session({"token": "x"})


class TestEndpointSignatures(unittest.TestCase):
    """The endpoints the mobile app will call must actually accept what it sends.

    Cheap, and it catches the whole class of "the app sends a parameter the server
    silently drops" — which is exactly what `via_tick` does today on `register_csu_scan`.
    """

    def test_start_and_end_accept_a_client_moment(self):
        import inspect

        from upande_scp.serverscripts.spray_plan_creator import spray_session as SS

        self.assertIn(
            "started_at", inspect.signature(SS.start_spray_session).parameters
        )
        self.assertIn("ended_at", inspect.signature(SS.end_spray_session).parameters)

    def test_manufacture_accepts_a_posting_moment(self):
        import inspect

        from upande_scp.serverscripts.spray_plan_creator import spray_session as SS

        self.assertIn(
            "posting_moment", inspect.signature(SS.manufacture_tank_mix).parameters
        )

    def test_a_scan_accepts_the_moment_it_was_taken(self):
        import inspect

        from upande_scp.serverscripts.spray_plan_creator import spray_session as SS

        self.assertIn(
            "scanned_at", inspect.signature(SS.register_csu_scan).parameters
        )

    def test_the_material_issue_accepts_a_posting_moment(self):
        import inspect

        from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
            build_and_submit_material_issue,
            build_material_issue,
        )

        self.assertIn(
            "posting_moment",
            inspect.signature(build_and_submit_material_issue).parameters,
        )
        self.assertIn(
            "posting_moment", inspect.signature(build_material_issue).parameters
        )

    def test_the_logsheet_can_hold_a_dated_stop_time(self):
        """Its `Time` fields carry no date, so a session crossing midnight would be
        unreconstructable without these."""
        meta = frappe.get_meta("Spray Application Logsheet")
        self.assertTrue(meta.get_field("custom_application_stop_at"))
        self.assertTrue(meta.get_field("custom_application_start_at"))
