"""Stale-plan suggestions (hold window) and the planning window.

Holding and cancelling are separate. A plan holds its chemicals for
``reservation_window_days`` (default 5) from PLANNING: the later of its creation and its
latest Approved postponement. After that it no longer holds them and is *suggested* for
cancelling (``get_stale_plans``); only a person's "Cancel selected"
(``stop_stale_plans``) cancels it, which releases the ERPNext reservation and notifies
the creator. Nothing cancels on a schedule.

A plan may be dated at most the same number of days ahead: exactly N is fine, N+1 is
refused.

The site has real plans, so every call is narrowed to the plans this test created.

Run: bench --site kaitet.local run-tests \
        --module upande_scp.serverscripts.tests.test_release_stale_allocations
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import add_to_date, now_datetime

from upande_scp.serverscripts.spray_plan_creator import maintenance as M
from upande_scp.serverscripts.spray_plan_creator import reservations as R
from upande_scp.serverscripts.tests import afp_fixture as AF

SETTINGS = "Scouting and Crop Protection Settings"


def _reserved(fx):
    return frappe.db.get_value(
        "Bin", {"item_code": fx.chem, "warehouse": fx.store}, "reserved_qty_for_production"
    ) or 0


class TestStaleSuggestions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.flags.in_test = True
        frappe.set_user("Administrator")
        cls.before = frappe.db.sql(
            "SELECT value FROM tabSingles WHERE doctype=%s AND field='reservation_window_days'",
            (SETTINGS,))
        cls.fx = AF.ThrowawayPlan("RSA")
        try:
            cls.fx.build()  # first plan: its chemicals are already transferred
        except Exception:
            frappe.db.rollback()
            AF.wipe(cls.fx.prefix)
            raise
        cls.transferred = cls.fx.wo.name

    @classmethod
    def tearDownClass(cls):
        if cls.before:
            frappe.db.set_single_value(SETTINGS, "reservation_window_days", cls.before[0][0])
        else:
            frappe.db.sql(
                "DELETE FROM tabSingles WHERE doctype=%s AND field='reservation_window_days'",
                (SETTINGS,))
        frappe.clear_cache(doctype=SETTINGS)
        frappe.db.commit()
        AF.wipe(cls.fx.prefix)

    def setUp(self):
        frappe.set_user("Administrator")
        self._window(5)
        self._age(self.transferred, 30)
        frappe.db.sql("DELETE FROM `tabSpray Plan Postponement` WHERE work_order IN %s",
                      (self.fx.wo_names,))

    def _window(self, n):
        frappe.db.set_single_value(SETTINGS, "reservation_window_days", n)
        frappe.clear_cache(doctype=SETTINGS)
        frappe.db.commit()

    def _age(self, wo, days):
        frappe.db.set_value("Work Order", wo, "creation",
                            add_to_date(now_datetime(), days=-days), update_modified=False)
        frappe.db.commit()

    def _plan(self, days=30, state="Approved"):
        wo = self.fx.add_plan(transfer=False).name
        frappe.db.set_value("Work Order", wo, "workflow_state", state, update_modified=False)
        self._age(wo, days)
        return wo

    def _stale(self):
        mine = set(self.fx.wo_names)
        return {r["name"]: r for r in R.get_stale_plans() if r["name"] in mine}

    def _status(self, wo):
        return frappe.db.get_value("Work Order", wo, "status")

    def _postpone(self, wo, decided_days_ago, status="Approved"):
        frappe.get_doc({
            "doctype": "Spray Plan Postponement", "work_order": wo, "status": status,
            "from_datetime": now_datetime(), "to_datetime": add_to_date(now_datetime(), days=3),
            "reason": "test", "decided_on": add_to_date(now_datetime(), days=-decided_days_ago),
        }).insert(ignore_permissions=True)
        frappe.db.commit()

    def test_old_plan_is_suggested_with_what_it_held_and_nothing_cancels_it(self):
        wo = self._plan()
        row = self._stale()[wo]
        self.assertEqual(row["owner"], frappe.db.get_value("Work Order", wo, "owner"))
        self.assertTrue(row["hold_started"])
        self.assertEqual(row["held"], [{"item": self.fx.chem, "warehouse": self.fx.store,
                                        "qty": self.fx.qty}])
        # Suggesting changes nothing.
        self.assertNotEqual(self._status(wo), "Stopped")

    def test_cancelling_releases_the_reservation_and_notifies_the_creator(self):
        wo = self._plan()
        before = _reserved(self.fx)
        self.assertGreaterEqual(before, self.fx.qty)
        with mock.patch.object(M, "_notify_creator") as notify:
            res = R.stop_stale_plans([wo])
        self.assertEqual(res["stopped"], [wo])
        self.assertEqual(self._status(wo), "Stopped")
        self.assertAlmostEqual(_reserved(self.fx), before - self.fx.qty, places=4)
        notify.assert_called_once()
        self.assertIn("were released", notify.call_args.args[2])

    def test_plan_inside_its_window_is_not_suggested_or_cancelled(self):
        wo = self._plan(days=3)
        self.assertNotIn(wo, self._stale())
        self.assertEqual(R.stop_stale_plans([wo])["skipped"], [wo])
        self.assertNotEqual(self._status(wo), "Stopped")

    def test_issued_and_spraying_plans_are_never_suggested(self):
        names = [self._plan(state=s) for s in
                 ("Spraying In Progress", "Completed", "Chemical Issued", "Tank Mix Manufactured")]
        self.assertFalse(set(names) & set(self._stale()))

    def test_fully_transferred_plan_is_not_suggested(self):
        self.assertNotIn(self.transferred, self._stale())

    def test_postponement_gives_a_fresh_hold(self):
        wo = self._plan(days=30)
        self._postpone(wo, decided_days_ago=2)
        self.assertNotIn(wo, self._stale())
        self.assertEqual(R.stop_stale_plans([wo])["skipped"], [wo])

    def test_an_old_or_rejected_postponement_does_not_save_the_plan(self):
        a = self._plan(days=30)
        self._postpone(a, decided_days_ago=9)
        b = self._plan(days=30)
        self._postpone(b, decided_days_ago=1, status="Rejected")
        self.assertTrue({a, b} <= set(self._stale()))

    def test_the_hold_runs_from_planning_not_the_spray_date(self):
        # Planned long ago for a spray date in the future: its hold has run out.
        wo = self._plan(days=30)
        frappe.db.set_value("Work Order", wo, "planned_start_date",
                            add_to_date(now_datetime(), days=2), update_modified=False)
        frappe.db.commit()
        self.assertIn(wo, self._stale())
        # Planned today for a spray date long past: still holding.
        fresh = self._plan(days=0)
        frappe.db.set_value("Work Order", fresh, "planned_start_date",
                            add_to_date(now_datetime(), days=-20), update_modified=False)
        frappe.db.commit()
        self.assertNotIn(fresh, self._stale())

    def test_the_window_is_the_one_setting(self):
        wo = self._plan(days=10)
        self._window(14)
        self.assertNotIn(wo, self._stale())
        self._window(5)
        self.assertIn(wo, self._stale())

    def test_nothing_is_scheduled_to_cancel_plans(self):
        from upande_scp import hooks
        jobs = [j for v in hooks.scheduler_events.values()
                for j in (v if isinstance(v, list) else [x for l in v.values() for x in l])]
        self.assertFalse([j for j in jobs if "release_stale" in j])
        self.assertFalse(hasattr(M, "release_stale_allocations"))


class TestPlanningWindow(unittest.TestCase):
    def setUp(self):
        frappe.flags.in_test = True
        frappe.db.set_single_value(SETTINGS, "reservation_window_days", 5)
        frappe.clear_cache(doctype=SETTINGS)

    def tearDown(self):
        frappe.db.sql("DELETE FROM tabSingles WHERE doctype=%s AND field='reservation_window_days'",
                      (SETTINGS,))
        frappe.clear_cache(doctype=SETTINGS)
        frappe.db.commit()

    def _on(self, days):
        from frappe.utils import add_days
        from upande_scp.serverscripts.spray_plan_creator import planning_window as W
        return W, f"{add_days(W.today(), days)} 06:00:00"

    def test_exactly_n_days_ahead_is_allowed(self):
        W, d = self._on(5)
        self.assertIsNone(W.refusal_for(d))

    def test_n_plus_one_is_refused_with_the_earliest_date(self):
        W, d = self._on(6)
        msg = W.refusal_for(d)
        self.assertIn("at most 5 days ahead", msg)
        self.assertIn("6 days away", msg)
        self.assertIn("on or after " + str(frappe.utils.add_days(d[:10], -5)), msg)
        with self.assertRaises(frappe.ValidationError):
            W.enforce(d)

    def test_today_past_and_blank_are_not_this_rules(self):
        W, d = self._on(0)
        self.assertIsNone(W.refusal_for(d))
        self.assertIsNone(W.refusal_for(self._on(-3)[1]))
        self.assertIsNone(W.refusal_for(None))

    def test_the_window_follows_the_setting(self):
        frappe.db.set_single_value(SETTINGS, "reservation_window_days", 2)
        frappe.clear_cache(doctype=SETTINGS)
        W, d = self._on(3)
        self.assertIn("at most 2 days", W.refusal_for(d))

    def test_endpoint_reports_the_window(self):
        from upande_scp.serverscripts.spray_plan_creator import planning_window as W
        r = W.planning_window()
        self.assertEqual(r["days"], 5)
