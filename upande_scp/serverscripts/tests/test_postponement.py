"""Postponing a spray plan.

Three things here would cause real damage if wrong:

* **the deadline is measured from the plan's own date**, not from today. Anchoring it
  to today would leave last week's plan permanently sprayable every morning, which is
  the thing a cutoff exists to stop.
* **the state boundary.** Postponement stops before `Tank Mix Manufactured`: once the
  mix exists, moving the date records a spray using chemical that is no longer what it
  was.
* **auto-cancel must not eat a postponed plan.** Dormancy is measured from creation, so
  a plan deliberately moved to next week would otherwise be stopped today for being
  old — the opposite of what the postponement said.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_postponement
"""

import unittest
from contextlib import contextmanager

import frappe
from frappe.utils import add_days, get_datetime, getdate, now_datetime

from upande_scp.serverscripts.spray_plan_creator import postponement as P

SETTINGS = "Scouting and Crop Protection Settings"


@contextmanager
def settings(**values):
    """Set settings fields for one test and put them back."""
    before = {k: frappe.db.get_single_value(SETTINGS, k) for k in values}
    for k, v in values.items():
        frappe.db.set_single_value(SETTINGS, k, v)
    frappe.clear_cache(doctype=SETTINGS)
    frappe.db.commit()
    try:
        yield
    finally:
        for k, v in before.items():
            frappe.db.set_single_value(SETTINGS, k, v)
        frappe.clear_cache(doctype=SETTINGS)
        frappe.db.commit()


class TestDeadline(unittest.TestCase):
    """The cutoff arithmetic, with no site state involved."""

    def test_the_deadline_is_the_plans_own_date_at_the_cutoff(self):
        with settings(spray_cutoff_time="10:00:00"):
            self.assertEqual(
                P.deadline_for("2026-08-11 06:00:00"),
                get_datetime("2026-08-11 10:00:00"),
            )

    def test_a_plan_from_last_week_is_long_past_its_deadline(self):
        """The failure this prevents: anchoring the cutoff to *today* would make every
        stale plan sprayable again each morning."""
        with settings(spray_cutoff_time="10:00:00"):
            old = add_days(getdate(now_datetime()), -7)
            self.assertLess(P.deadline_for(old), now_datetime())

    def test_a_plan_scheduled_for_next_week_is_not_past_its_deadline(self):
        with settings(spray_cutoff_time="10:00:00"):
            future = add_days(getdate(now_datetime()), 7)
            self.assertGreater(P.deadline_for(future), now_datetime())

    def test_an_unscheduled_plan_has_no_deadline_rather_than_an_expired_one(self):
        self.assertIsNone(P.deadline_for(None))
        self.assertIsNone(P.deadline_for(""))

    def test_the_cutoff_time_comes_from_settings(self):
        with settings(spray_cutoff_time="06:30:00"):
            self.assertEqual(
                P.deadline_for("2026-08-11"), get_datetime("2026-08-11 06:30:00")
            )

    def test_a_missing_cutoff_falls_back_to_the_default(self):
        with settings(spray_cutoff_time=None):
            self.assertEqual(P.cutoff_time(), P.DEFAULT_CUTOFF)

    def test_a_garbled_max_days_falls_back_rather_than_throwing(self):
        with settings(postponement_max_days=0):
            self.assertEqual(P.max_days(), P.DEFAULT_MAX_DAYS)


class TestPostponementFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.wo = frappe.db.get_value(
            "Work Order",
            {"custom_type": P.AFP_TYPE, "workflow_state": ("in", P.POSTPONABLE_STATES)},
            "name",
        )
        if not cls.wo:
            raise unittest.SkipTest("no postponable AFP work order on this site")
        cls.original = frappe.db.get_value(
            "Work Order", cls.wo,
            ["custom_scheduled_application_time", "planned_start_date"],
            as_dict=True,
        )

    def setUp(self):
        frappe.set_user("Administrator")
        self._clear()
        # Put the plan on today so the cutoff logic has something live to bite on.
        frappe.db.set_value(
            "Work Order", self.wo,
            {
                "custom_scheduled_application_time": f"{getdate(now_datetime())} 06:00:00",
                "planned_start_date": f"{getdate(now_datetime())} 06:00:00",
            },
            update_modified=False,
        )
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        cls._clear()
        frappe.db.set_value(
            "Work Order", cls.wo,
            {
                "custom_scheduled_application_time": cls.original.custom_scheduled_application_time,
                "planned_start_date": cls.original.planned_start_date,
            },
            update_modified=False,
        )
        frappe.db.commit()

    @classmethod
    def _clear(cls):
        for name in frappe.get_all(P.DOCTYPE, filters={"work_order": cls.wo}, pluck="name"):
            frappe.delete_doc(P.DOCTYPE, name, force=True, ignore_permissions=True)
        frappe.db.commit()

    def _tomorrow(self):
        return f"{add_days(getdate(now_datetime()), 1)} 06:00:00"

    # ── declaring ───────────────────────────────────────────────────

    def test_declaring_needs_a_reason(self):
        with settings(spray_cutoff_time="23:59:00"):
            with self.assertRaises(frappe.ValidationError):
                P.declare(self.wo, self._tomorrow(), "   ")

    def test_declaring_does_not_move_the_plan_yet(self):
        """A pending request must not change what the store and sprayers work to."""
        with settings(spray_cutoff_time="23:59:00"):
            before = frappe.db.get_value(
                "Work Order", self.wo, "custom_scheduled_application_time"
            )
            P.declare(self.wo, self._tomorrow(), "rain since dawn")
            after = frappe.db.get_value(
                "Work Order", self.wo, "custom_scheduled_application_time"
            )
        self.assertEqual(before, after)

    def test_only_one_request_may_be_pending_at_a_time(self):
        with settings(spray_cutoff_time="23:59:00"):
            P.declare(self.wo, self._tomorrow(), "rain")
            with self.assertRaises(frappe.ValidationError) as cm:
                P.declare(self.wo, self._tomorrow(), "rain again")
        self.assertIn("awaiting a decision", str(cm.exception))

    def test_it_must_move_the_spray_later(self):
        with settings(spray_cutoff_time="23:59:00"):
            yesterday = f"{add_days(getdate(now_datetime()), -1)} 06:00:00"
            with self.assertRaises(frappe.ValidationError) as cm:
                P.declare(self.wo, yesterday, "backwards")
        self.assertIn("later", str(cm.exception))

    def test_it_cannot_be_pushed_past_the_bound(self):
        """A plan deferred indefinitely has been abandoned without anybody saying so."""
        with settings(spray_cutoff_time="23:59:00", postponement_max_days=3):
            too_far = f"{add_days(getdate(now_datetime()), 30)} 06:00:00"
            with self.assertRaises(frappe.ValidationError) as cm:
                P.declare(self.wo, too_far, "next month")
        self.assertIn("abandoned", str(cm.exception))

    def test_past_the_cutoff_it_can_no_longer_be_declared(self):
        with settings(spray_cutoff_time="00:01:00", postponement_grace_minutes=0):
            with self.assertRaises(frappe.ValidationError) as cm:
                P.declare(self.wo, self._tomorrow(), "too late")
        self.assertIn("deadline", str(cm.exception).lower())

    def test_the_grace_window_extends_declaring_but_not_starting(self):
        """The supervisor standing in the field at 10:01 gets slack; a late spray does
        not, because the point of the cutoff is that nobody planned for it."""
        now = now_datetime()
        just_passed = (now - frappe.utils.datetime.timedelta(minutes=5)).strftime("%H:%M:%S")
        with settings(spray_cutoff_time=just_passed, postponement_grace_minutes=60):
            status = P.cutoff_status(self.wo)
            self.assertTrue(status["past_cutoff"])
            self.assertTrue(status["can_postpone"], "grace should still allow a request")
            self.assertFalse(status["can_start"], "a late spray must stay refused")

    # ── the state boundary ──────────────────────────────────────────

    def test_a_manufactured_tank_mix_cannot_be_postponed(self):
        """The decision: once mixed, spray it or stop it. Moving the date would record
        a spray using chemical that is no longer what it was."""
        before = frappe.db.get_value("Work Order", self.wo, "workflow_state")
        frappe.db.set_value(
            "Work Order", self.wo, "workflow_state", P.STATE_MANUFACTURED,
            update_modified=False,
        )
        frappe.db.commit()
        try:
            with settings(spray_cutoff_time="23:59:00"):
                with self.assertRaises(frappe.ValidationError) as cm:
                    P.declare(self.wo, self._tomorrow(), "rain")
            self.assertIn("does not keep", str(cm.exception))
        finally:
            frappe.db.set_value(
                "Work Order", self.wo, "workflow_state", before, update_modified=False
            )
            frappe.db.commit()

    def test_every_state_before_the_mix_is_postponable(self):
        self.assertEqual(
            P.POSTPONABLE_STATES,
            ("Pending Submission", "Awaiting Approval", "Approved", "Chemical Issued"),
        )
        self.assertNotIn(P.STATE_MANUFACTURED, P.POSTPONABLE_STATES)
        for later in ("Spraying In Progress", "Completed"):
            self.assertNotIn(later, P.POSTPONABLE_STATES)

    # ── deciding ────────────────────────────────────────────────────

    def test_approving_moves_both_date_fields_together(self):
        """They are written as a pair at creation; updating one alone makes the plan
        say two different things about when it happens."""
        target = self._tomorrow()
        with settings(spray_cutoff_time="23:59:00"):
            req = P.declare(self.wo, target, "rain")
            P.decide(req["name"], "approve")
        row = frappe.db.get_value(
            "Work Order", self.wo,
            ["custom_scheduled_application_time", "planned_start_date"],
            as_dict=True,
        )
        self.assertEqual(
            get_datetime(row.custom_scheduled_application_time), get_datetime(target)
        )
        self.assertEqual(get_datetime(row.planned_start_date), get_datetime(target))

    def test_rejecting_leaves_the_date_alone_but_keeps_the_record(self):
        with settings(spray_cutoff_time="23:59:00"):
            before = frappe.db.get_value(
                "Work Order", self.wo, "custom_scheduled_application_time"
            )
            req = P.declare(self.wo, self._tomorrow(), "rain")
            out = P.decide(req["name"], "reject", "spray it this afternoon")
        self.assertEqual(out["status"], "Rejected")
        self.assertEqual(
            frappe.db.get_value("Work Order", self.wo, "custom_scheduled_application_time"),
            before,
        )
        self.assertTrue(
            [h for h in P.history_for(self.wo) if h.status == "Rejected"],
            "a refused slip is part of why the plan happened when it did",
        )

    def test_a_decision_is_made_once(self):
        with settings(spray_cutoff_time="23:59:00"):
            req = P.declare(self.wo, self._tomorrow(), "rain")
            P.decide(req["name"], "approve")
            with self.assertRaises(frappe.ValidationError):
                P.decide(req["name"], "reject")

    def test_a_request_cannot_be_applied_once_the_plan_has_moved_on(self):
        """The plan can advance while a request sits waiting; applying the date then
        would contradict the state it reached."""
        with settings(spray_cutoff_time="23:59:00"):
            req = P.declare(self.wo, self._tomorrow(), "rain")
            before = frappe.db.get_value("Work Order", self.wo, "workflow_state")
            frappe.db.set_value(
                "Work Order", self.wo, "workflow_state", P.STATE_MANUFACTURED,
                update_modified=False,
            )
            frappe.db.commit()
            try:
                with self.assertRaises(frappe.ValidationError) as cm:
                    P.decide(req["name"], "approve")
                self.assertIn("no longer be applied", str(cm.exception))
            finally:
                frappe.db.set_value(
                    "Work Order", self.wo, "workflow_state", before,
                    update_modified=False,
                )
                frappe.db.commit()

    def test_the_declarer_can_withdraw_their_own_request(self):
        with settings(spray_cutoff_time="23:59:00"):
            req = P.declare(self.wo, self._tomorrow(), "rain")
            out = P.withdraw(req["name"], "cleared up")
        self.assertEqual(out["status"], "Withdrawn")

    # ── interaction with auto-cancel ────────────────────────────────

    def test_a_postponed_plan_is_not_swept_up_as_dormant(self):
        """Dormancy runs from creation, so without this guard a plan moved to next week
        gets stopped today for being old."""
        from upande_scp.serverscripts.spray_plan_creator import maintenance

        with settings(spray_cutoff_time="23:59:00"):
            req = P.declare(self.wo, self._tomorrow(), "rain")
            self.assertTrue(maintenance._recently_postponed(self.wo))
            P.decide(req["name"], "approve")
            self.assertTrue(
                maintenance._recently_postponed(self.wo),
                "an approved postponement must keep protecting the plan",
            )

    def test_a_rejected_postponement_stops_protecting_the_plan(self):
        from upande_scp.serverscripts.spray_plan_creator import maintenance

        with settings(spray_cutoff_time="23:59:00"):
            req = P.declare(self.wo, self._tomorrow(), "rain")
            P.decide(req["name"], "reject", "no")
        self.assertFalse(maintenance._recently_postponed(self.wo))

    # ── what the client is told ─────────────────────────────────────

    def test_the_settings_endpoint_reports_the_deadline(self):
        with settings(spray_cutoff_time="09:15:00", postponement_max_days=5):
            out = P.postponement_settings()
        self.assertEqual(out["cutoff_time"], "09:15:00")
        self.assertEqual(out["max_days"], 5)
        self.assertIn("Chemical Issued", out["postponable_states"])


class TestSettingsWiring(unittest.TestCase):
    """A settings field is only real once it round-trips through the editor's own
    read/write path.

    `save_spray_plan_settings` copies a **whitelist** of scalar fields, so a field with
    a doctype definition and a UI control still saves to nothing if it was not added
    here. That is exactly what had happened to `allocation_balancing_enabled`: the
    checkbox existed, the doctype field existed, and ticking it did nothing.
    """

    KEYS = (
        "allocation_balancing_enabled",
        "spray_cutoff_time",
        "postponement_max_days",
        "postponement_grace_minutes",
    )

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        from upande_scp.serverscripts.spray_plan_creator import settings as S

        cls.S = S
        cls.before = {
            k: S.get_settings_bundle()["spray_plan"].get(k) for k in cls.KEYS
        }

    @classmethod
    def tearDownClass(cls):
        import json

        cls.S.save_spray_plan_settings(json.dumps(cls.before))
        frappe.db.commit()

    def test_every_field_is_readable_through_the_bundle(self):
        got = self.S.get_settings_bundle()["spray_plan"]
        for key in self.KEYS:
            self.assertIn(key, got, f"{key} is not exposed to the settings editor")

    def test_every_field_survives_a_save(self):
        import json

        wanted = {
            "allocation_balancing_enabled": 1,
            "spray_cutoff_time": "09:30:00",
            "postponement_max_days": 5,
            "postponement_grace_minutes": 45,
        }
        self.S.save_spray_plan_settings(json.dumps(wanted))
        got = self.S.get_settings_bundle()["spray_plan"]
        for key, value in wanted.items():
            self.assertEqual(
                str(got.get(key)), str(value),
                f"{key} did not persist — check the scalar_fields whitelist",
            )

    def test_the_cutoff_the_editor_shows_is_the_one_the_server_enforces(self):
        """Two readers of one setting is how the screen and the rule drift apart."""
        import json

        self.S.save_spray_plan_settings(json.dumps({"spray_cutoff_time": "07:45:00"}))
        frappe.clear_cache(doctype=SETTINGS)
        self.assertEqual(
            self.S.get_settings_bundle()["spray_plan"]["spray_cutoff_time"],
            P.cutoff_time(),
        )


class TestCutoffRobustness(unittest.TestCase):
    """A cutoff of midnight would lock the whole site out of spraying.

    Found the hard way: a half-finished save left `spray_cutoff_time` at `0:00:00` on
    kaitet, and because `"0:00:00"` is a truthy string the `or DEFAULT` fallback did not
    catch it. Every plan was instantly past its deadline.
    """

    def test_midnight_is_treated_as_unset_not_as_a_policy(self):
        for garbage in ("0:00:00", "00:00:00", "00:00", "", None, "   "):
            with settings(spray_cutoff_time=garbage):
                self.assertEqual(
                    P.cutoff_time(), P.DEFAULT_CUTOFF,
                    f"{garbage!r} should fall back, not lock the site out",
                )

    def test_a_genuinely_early_cutoff_is_respected(self):
        """Only all-zero is rejected — an early morning deadline is a real choice."""
        with settings(spray_cutoff_time="00:30:00"):
            self.assertEqual(P.cutoff_time(), "00:30:00")
        with settings(spray_cutoff_time="05:00:00"):
            self.assertEqual(P.cutoff_time(), "05:00:00")

    def test_a_plan_today_is_actionable_under_the_fallback(self):
        """The end-to-end consequence: with the cutoff unset, today's plan is still
        sprayable in the morning rather than dead on arrival."""
        with settings(spray_cutoff_time=None):
            deadline = P.deadline_for(getdate(now_datetime()))
            self.assertEqual(str(deadline)[-8:], P.DEFAULT_CUTOFF)
