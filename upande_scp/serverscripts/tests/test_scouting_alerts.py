"""Scouting Alerts: evaluation, one alert per key, escalation, recipients and the
endpoints (thresholds spec D3–D6). DB test — direct runner; rolled back in tearDown.
The five _test_scp_alert_* users are committed once, like test_notifications'."""

import unittest
from datetime import date, datetime
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import thresholds_fixture as TF

U_CREATOR = "_test_scp_alert_creator@example.com"
U_SUPER = "_test_scp_alert_super@example.com"
U_APPROVER = "_test_scp_alert_approver@example.com"
U_GM = "_test_scp_alert_gm@example.com"
U_STRANGER = "_test_scp_alert_stranger@example.com"   # on no roster, no role
SUN_20, SUN_21, SUN_22 = date(2031, 5, 18), date(2031, 5, 25), date(2031, 6, 1)


def live_plan():
    """A submitted, running Work Order: a curative plan that still owns its alert."""
    return frappe.db.get_value("Work Order", {"docstatus": 1, "status": "Not Started"}, "name")


def dead_plan():
    """A Stopped Work Order (auto-cancelled or rejected)."""
    return frappe.db.get_value("Work Order", {"docstatus": 1, "status": "Stopped"}, "name")


def at(day, hour=9, minute=0):
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=TC.EAT)


class AlertCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        for user in (U_CREATOR, U_SUPER, U_APPROVER, U_GM, U_STRANGER):
            TF.ensure_user(user)

    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh, self.gh2 = PF.rose_greenhouses(2)
        self.farm = frappe.db.get_value("Warehouse", self.gh, "custom_farm")
        TF.clear_all_bands("Rose")
        TF.set_roster(self.farm, "creators", [U_CREATOR])
        TF.set_roster(self.farm, "supervisors", [U_SUPER])
        TF.set_roster(self.farm, "approvers", [U_APPROVER])
        self.gms = patch.object(TC, "_gms", return_value=[U_GM])
        self.gms.start()
        self.clock = patch.object(TC, "now_eat", return_value=at(SUN_20))
        self.clock.start()

    def tearDown(self):
        self.gms.stop()
        self.clock.stop()
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        crop_scope.clear_cache()
        frappe.db.rollback()

    def alert(self, gh=None, week="2031-W20", stage=""):
        return frappe.db.get_value(
            "Scouting Alert", TC.alert_name(gh or self.gh, "Pest", "Thrips", stage, week),
            ["name", "action", "status", "notified_action", "notified", "value", "reliability", "raised_on"],
            as_dict=True,
        )

    def told(self, user, alert):
        return frappe.db.count("Notification Log", {
            "for_user": user, "document_type": "Scouting Alert", "document_name": alert,
            "scp_category": "scouting",
        })

    def raise_spray_advised(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")              # 9 of 27 → 33.3 %, Fair
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        TC.check_crop("Rose", SUN_20)
        return self.alert().name


class TestEvaluate(AlertCase):
    def _found(self):
        return {f["warehouse"]: f for f in TC.evaluate("Rose", SUN_20)
                if f["observation"] == "Thrips" and not f["stage"]}

    def test_bands_map_to_alarming_spray_advised_and_scout_first(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.seed_week(self.gh2, TF.WEEK_20[0], crop="Rose", sections={(0, 0)})   # one section: Low
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        found = self._found()
        self.assertEqual((found[self.gh]["value"], found[self.gh]["reliability"], found[self.gh]["action"]),
                         (33.3, "Fair", "Spray advised"))
        self.assertEqual((found[self.gh2]["value"], found[self.gh2]["reliability"], found[self.gh2]["action"]),
                         (33.3, "Low", "Scout first"))
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        self.assertEqual(self._found()[self.gh]["action"], "Alarming")
        TF.set_bands("Rose", "Thrips", 0, 50, 90)
        below = self._found()[self.gh]
        self.assertEqual((below["band"], below["action"]), ("", None))

    def test_a_count_row_is_evaluated_per_zone(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", count=3)
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        f = self._found()[self.gh]
        self.assertEqual((f["measure"], f["value"], f["unit"], f["action"]), ("Count", 1.0, "per zone", "Alarming"))

    def test_no_bands_or_no_scouting_means_no_finding(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        self.assertEqual(TC.evaluate("Rose", SUN_20), [])
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        self.assertEqual(TC.evaluate("Rose", date(2031, 7, 6)), [])


class TestAlerts(AlertCase):
    def test_rerunning_the_check_writes_one_alert_and_notifies_once(self):
        name = self.raise_spray_advised()
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "iso_week": "2031-W20"}), 1)
        self.assertEqual((a.action, a.status, a.notified_action), ("Spray advised", "Open", "Spray advised"))
        for user in (U_CREATOR, U_SUPER, U_APPROVER, U_GM):
            self.assertEqual(self.told(user, name), 1, user)
        self.assertEqual(sorted(a.notified.split("\n")), sorted([U_APPROVER, U_CREATOR, U_GM, U_SUPER]))
        self.assertEqual(str(a.raised_on), "2031-05-18")

    def test_a_crossed_stage_band_is_its_own_alert(self):
        # R2: the key includes the stage — the row band and the Adult band each alert.
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.set_bands("Rose", "Thrips", 0, 30, 60, stage_bands={"Adult": (0, 10, 30)})
        TC.check_crop("Rose", SUN_20)
        row, adult = self.alert(), self.alert(stage="Adult")
        self.assertNotEqual(row.name, adult.name)
        self.assertEqual((row.action, adult.action), ("Alarming", "Spray advised"))
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "iso_week": "2031-W20"}), 2)

    def test_a_concurrent_insert_of_the_same_key_is_absorbed_silently(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        finding = next(f for f in TC.evaluate("Rose", SUN_20) if f["warehouse"] == self.gh)
        name = TC.upsert(finding)                       # the other worker got there first
        winner = TC._existing(name)
        with patch.object(TC, "_existing", side_effect=[None, winner]):
            self.assertEqual(TC.upsert(finding), name)  # inserts, collides, re-reads
        self.assertEqual(frappe.db.count("Scouting Alert", {"name": name}), 1)
        self.assertEqual(self.told(U_CREATOR, name), 1)

    def test_the_hourly_gate_lets_one_run_through(self):
        TC.clear_gate(TC.CHECK_GATE_KEY)
        try:
            first = TC.run_threshold_check(today=SUN_20, commit=False)
            second = TC.run_threshold_check(today=SUN_20, commit=False)
        finally:
            TC.clear_gate(TC.CHECK_GATE_KEY)
        self.assertIn("crops", first)
        self.assertEqual(second, {"skipped": "ran less than 50 minutes ago"})

    def test_escalation_within_a_week_notifies_again_and_a_repeat_does_not(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")                       # 33.3 %
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual(a.action, "Alarming")
        self.assertEqual((self.told(U_CREATOR, a.name), self.told(U_SUPER, a.name)), (1, 1))
        self.assertEqual((self.told(U_APPROVER, a.name), self.told(U_GM, a.name)), (0, 0))   # D4
        TF.seed_week(self.gh, "2031-05-15", crop="Rose", infested_per_section=2)  # same week → 66.7 %
        TC.check_crop("Rose", SUN_20)
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual((a.action, a.notified_action), ("Spray advised", "Spray advised"))
        self.assertEqual(self.told(U_CREATOR, a.name), 2)
        self.assertEqual((self.told(U_APPROVER, a.name), self.told(U_GM, a.name)), (1, 1))

    def test_next_week_at_the_same_action_is_silent_and_supersedes_the_old_alert(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        TF.seed_week(self.gh, TF.WEEK_21[0], crop="Rose")
        TC.check_crop("Rose", SUN_21)
        old, new = self.alert(week="2031-W20"), self.alert(week="2031-W21")
        self.assertEqual(old.status, "Resolved")
        self.assertEqual((new.action, new.status, new.notified_action), ("Alarming", "Open", "Alarming"))
        self.assertEqual(self.told(U_CREATOR, new.name), 0)          # carried, not re-announced (D5)
        TF.seed_week(self.gh, "2031-05-22", crop="Rose", infested_per_section=2)
        TC.check_crop("Rose", SUN_21)
        self.assertEqual(self.told(U_CREATOR, new.name), 1)          # an escalation does notify

    def test_a_recurrence_after_a_clean_week_notifies(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        TF.seed_week(self.gh, TF.WEEK_21[0], crop="Rose", infested_per_section=0)   # scouted clean
        TC.check_crop("Rose", SUN_21)
        self.assertEqual(self.alert(week="2031-W20").status, "Resolved")
        self.assertIsNone(self.alert(week="2031-W21"))
        TF.seed_week(self.gh, TF.WEEK_22[0], crop="Rose")
        TC.check_crop("Rose", SUN_22)
        self.assertEqual(self.told(U_CREATOR, self.alert(week="2031-W22").name), 1)

    def test_a_thin_clean_start_to_the_week_does_not_resolve_last_weeks_alert(self):
        # Monday: the house's latest week switches to W21 with one clean
        # section (reliability Low). That must not resolve W20's Spray advised,
        # or W21 filling up would re-announce the same action to everyone.
        name = self.raise_spray_advised()                                   # W20 Spray advised
        mon = date(2031, 5, 19)
        self.clock.stop()
        self.clock = patch.object(TC, "now_eat", return_value=at(mon, 10))
        self.clock.start()
        TF.seed_week(self.gh, "2031-05-19", crop="Rose", infested_per_section=0, sections={(0, 0)})
        thin = next(f for f in TC.evaluate("Rose", mon) if f["warehouse"] == self.gh and not f["stage"])
        self.assertEqual((thin["iso_week"], thin["band"], thin["reliability"]), ("2031-W21", "", "Low"))
        TC.check_crop("Rose", mon)
        self.assertEqual(self.alert(week="2031-W20").status, "Open")
        TF.seed_week(self.gh, "2031-05-20", crop="Rose")                    # W21 fills: 33.3 %, Fair
        TC.check_crop("Rose", date(2031, 5, 20))
        new = self.alert(week="2031-W21")
        self.assertEqual((new.action, new.notified_action), ("Spray advised", "Spray advised"))
        self.assertEqual(self.told(U_CREATOR, new.name), 0)                 # carried, not re-announced
        self.assertEqual(self.told(U_CREATOR, name), 1)
        self.assertEqual(self.alert(week="2031-W20").status, "Resolved")    # superseded by W21

    def test_a_reliable_clean_week_or_an_ended_week_resolves_older_alerts(self):
        self.raise_spray_advised()
        TF.seed_week(self.gh, TF.WEEK_21[0], crop="Rose", infested_per_section=0)   # full clean week
        TC.check_crop("Rose", SUN_21)
        self.assertEqual(self.alert(week="2031-W20").status, "Resolved")

    def test_a_thin_clean_week_resolves_older_alerts_once_the_week_has_ended(self):
        self.raise_spray_advised()
        TF.seed_week(self.gh, "2031-05-19", crop="Rose", infested_per_section=0, sections={(0, 0)})
        self.clock.stop()
        self.clock = patch.object(TC, "now_eat", return_value=at(date(2031, 5, 26), 10))  # W21 is over
        self.clock.start()
        TC.check_crop("Rose", SUN_21)
        self.assertEqual(self.alert(week="2031-W20").status, "Resolved")

    def test_acknowledged_stays_acknowledged_until_it_escalates(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        TC.acknowledge_alert(self.alert().name)
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.alert().status, "Acknowledged")
        TF.seed_week(self.gh, "2031-05-15", crop="Rose", infested_per_section=2)
        TC.check_crop("Rose", SUN_20)
        self.assertEqual((self.alert().status, self.alert().action), ("Open", "Spray advised"))

    def test_a_clustered_figure_with_no_margin_rewrites_and_reads_back_as_none(self):
        # One scouted section → m < 2 → margin None ("too clustered to judge").
        # The Float column is NOT NULL, so the second (update) run must not
        # write NULL; open_alerts recovers None from sections_scouted < 2.
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", sections={(0, 0)})
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        TC.check_crop("Rose", SUN_20)
        TC.check_crop("Rose", SUN_20)
        row = next(r for r in TC.open_alerts("Rose") if r.name == self.alert().name)
        self.assertEqual((row.action, row.sections_scouted, row.margin), ("Scout first", 1, None))

    def test_a_converted_alert_is_never_overwritten_or_renotified(self):
        # R15: once a curative plan owns the alert, the check leaves it alone.
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        name = self.alert().name
        frappe.db.set_value("Scouting Alert", name, {"status": "Converted to plan", "work_order": live_plan()})
        TF.seed_week(self.gh, "2031-05-15", crop="Rose", infested_per_section=2)  # would escalate
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual((a.status, a.action, a.notified_action), ("Converted to plan", "Alarming", "Alarming"))
        self.assertEqual(self.told(U_APPROVER, name), 0)
        self.assertEqual(self.told(U_CREATOR, name), 1)

    def test_a_recurrence_after_a_converted_alert_and_a_clean_week_notifies(self):
        # Only the immediately previous scouted week's alert is carried: a
        # Converted W20 must not silence W22 once W21 was scouted clean.
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        frappe.db.set_value("Scouting Alert", self.alert().name,
                            {"status": "Converted to plan", "work_order": live_plan()})
        TF.seed_week(self.gh, TF.WEEK_21[0], crop="Rose", infested_per_section=0)   # scouted clean
        TC.check_crop("Rose", SUN_21)
        TF.seed_week(self.gh, TF.WEEK_22[0], crop="Rose")
        TC.check_crop("Rose", SUN_22)
        new = self.alert(week="2031-W22")
        self.assertEqual((new.action, new.notified_action), ("Alarming", "Alarming"))
        self.assertEqual(self.told(U_CREATOR, new.name), 1)

    def test_a_converted_alert_whose_plan_died_reopens_and_escalates_normally(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)                                   # Alarming
        name = self.alert().name
        for plan in (dead_plan(), "WO-DELETED-SCP-TEST"):              # Stopped / deleted
            frappe.db.set_value("Scouting Alert", name, {"status": "Converted to plan", "work_order": plan})
            TC.check_crop("Rose", SUN_20)
            a = frappe.db.get_value("Scouting Alert", name, ["status", "work_order"], as_dict=True)
            self.assertEqual((a.status, a.work_order), ("Open", None), plan)
        self.assertEqual(self.told(U_CREATOR, name), 1)                 # same action: not re-announced
        frappe.db.set_value("Scouting Alert", name, {"status": "Converted to plan", "work_order": dead_plan()})
        TF.seed_week(self.gh, "2031-05-15", crop="Rose", infested_per_section=2)   # escalates
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual((a.status, a.action, a.notified_action), ("Open", "Spray advised", "Spray advised"))
        self.assertEqual(self.told(U_APPROVER, name), 1)

    def test_a_converted_alert_with_a_cancelled_plan_reopens(self):
        name = self.raise_spray_advised()
        cancelled = frappe.db.get_value("Work Order", {"docstatus": 2}, "name")
        frappe.db.set_value("Scouting Alert", name, {"status": "Converted to plan", "work_order": cancelled})
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.alert().status, "Open")

    def test_the_check_never_sends_email(self):
        with patch.object(frappe, "sendmail") as sendmail:
            name = self.raise_spray_advised()
        sendmail.assert_not_called()
        self.assertEqual(
            frappe.db.get_value("Notification Log", {"document_name": name, "for_user": U_CREATOR}, "type"),
            "Alert",   # Frappe never emails an "Alert" notification
        )

    def test_the_bell_link_names_the_alerts_crop(self):
        name = self.raise_spray_advised()
        link = frappe.db.get_value("Notification Log", {"document_name": name, "for_user": U_CREATOR}, "link")
        self.assertEqual(link, "/scp_app#/rose/dashboard")
        self.assertEqual(TC.dashboard_link("Passion Fruit"), "/scp_app#/passion-fruit/dashboard")

    def test_a_recipient_failure_never_blocks_the_alert(self):
        with patch.object(TC, "recipients_for", side_effect=RuntimeError("roster down")), \
                patch.object(frappe, "log_error") as log_error:
            self.raise_spray_advised()
        self.assertEqual(self.alert().action, "Spray advised")
        log_error.assert_called()


class TestSweep(AlertCase):
    def test_an_alert_whose_key_is_no_longer_banded_is_resolved(self):
        name = self.raise_spray_advised()
        TF.set_bands("Rose", "Aphids", 0, 10, 30)          # the crop stays banded
        TF.set_bands("Rose", "Thrips", 0, 0, 0)            # Thrips' band removed
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.alert().status, "Resolved")
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose")])

    def test_a_crop_with_no_bands_left_is_still_swept(self):
        self.raise_spray_advised()
        TF.clear_all_bands("Rose")
        TC.run_threshold_check(today=SUN_20, force=True, commit=False)
        self.assertEqual(self.alert().status, "Resolved")

    def test_an_alert_older_than_the_window_is_resolved(self):
        self.raise_spray_advised()                         # W20, house never scouted again
        TC.check_crop("Rose", SUN_21)                       # W20 still in the 14-day window
        self.assertEqual(self.alert().status, "Open")
        TC.check_crop("Rose", date(2031, 6, 8))             # window starts 05-26: W20 is out
        self.assertEqual(self.alert().status, "Resolved")

    def test_a_current_or_converted_alert_is_untouched(self):
        name = self.raise_spray_advised()
        frappe.db.set_value("Scouting Alert", name, "status", "Acknowledged")
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.alert().status, "Acknowledged")
        frappe.db.set_value("Scouting Alert", name, {"status": "Converted to plan", "work_order": live_plan()})
        TC.check_crop("Rose", date(2031, 6, 8))
        self.assertEqual(self.alert().status, "Converted to plan")


class TestRecipients(AlertCase):
    def test_recipients_follow_d4(self):
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.ALARMING), sorted([U_CREATOR, U_SUPER]))
        everyone = sorted([U_APPROVER, U_CREATOR, U_GM, U_SUPER])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.SPRAY_ADVISED), everyone)
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.SCOUT_FIRST), everyone)

    def test_an_empty_roster_falls_back_to_the_farms_gms_for_alarming(self):
        TF.set_roster(self.farm, "creators", [])
        TF.set_roster(self.farm, "supervisors", [])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.ALARMING), [U_GM])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.SPRAY_ADVISED), sorted([U_APPROVER, U_GM]))

    def test_nobody_to_tell_still_writes_the_alert(self):
        for roster in ("creators", "supervisors", "approvers"):
            TF.set_roster(self.farm, roster, [])
        with patch.object(TC, "_gms", return_value=[]):
            self.raise_spray_advised()
        a = self.alert()
        self.assertEqual((a.action, a.status), ("Spray advised", "Open"))
        self.assertFalse(a.notified)

    def test_gms_are_crop_scoped(self):
        self.gms.stop()
        try:
            self.assertIn(F.PETER, TC._gms(self.farm, "Rose"))
            self.assertNotIn(F.PETER, TC._gms("Lokitela", "Avocado"))
        finally:
            self.gms.start()


class TestEndpoints(AlertCase):
    def test_acknowledge_records_who_and_is_idempotent(self):
        name = self.raise_spray_advised()
        frappe.set_user(F.PETER)                       # an SCP General Manager on Rose
        self.assertEqual(TC.acknowledge_alert(name), {"name": name, "status": "Acknowledged"})
        self.assertEqual(TC.acknowledge_alert(name)["status"], "Acknowledged")
        frappe.set_user("Administrator")
        self.assertEqual(frappe.db.get_value("Scouting Alert", name, "acknowledged_by"), F.PETER)

    def test_a_recipient_may_acknowledge(self):
        # R5: being on the farm's roster for this action is the permission —
        # U_SUPER has no Employee and so no crop scope, yet was told.
        name = self.raise_spray_advised()
        frappe.set_user(U_SUPER)
        self.assertEqual(TC.acknowledge_alert(name)["status"], "Acknowledged")

    def test_acknowledge_is_refused_to_a_non_recipient(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        name = self.alert().name                        # Alarming: approvers are not told (D4)
        for user in (U_STRANGER, U_APPROVER):
            frappe.set_user(user)
            with self.assertRaises(frappe.PermissionError, msg=user):
                TC.acknowledge_alert(name)
        frappe.set_user("Administrator")
        self.assertEqual(frappe.db.get_value("Scouting Alert", name, "status"), "Open")

    def test_open_alerts_are_crop_and_farm_scoped(self):
        name = self.raise_spray_advised()
        mine = next(r for r in TC.open_alerts("Rose") if r.name == name)
        self.assertEqual((mine.unit, mine.action, mine.value, mine.status), ("%", "Spray advised", 33.3, "Open"))
        self.assertEqual(TC.open_alerts("Rose", farm="Lokitela"), [])
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose", greenhouse=self.gh2)])
        frappe.set_user(F.PETER)
        self.assertIn(name, [r.name for r in TC.open_alerts("Rose")])
        with self.assertRaises(frappe.PermissionError):
            TC.open_alerts("Avocado")

    def test_the_worst_alerts_survive_the_row_cap(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.seed_week(self.gh2, TF.WEEK_20[0], crop="Rose", sections={(0, 0)})   # one section: Low
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        TC.check_crop("Rose", SUN_20)
        worst = self.alert().name                                   # Spray advised
        lesser = self.alert(gh=self.gh2).name                       # Scout first
        # the worst is the OLDEST row: a modified-ordered cap would drop it
        frappe.db.set_value("Scouting Alert", worst, "modified", "2000-01-01 00:00:00", update_modified=False)
        rows = TC.open_alerts("Rose")
        self.assertEqual([r.name for r in rows], [worst, lesser])
        # more rows than the old 500 cap: the worst is still there, still first
        gh = frappe.get_doc("Scouting Alert", worst).as_dict()
        for i in range(501):
            d = frappe.get_doc({**{k: gh[k] for k in ("crop", "farm", "warehouse", "kind", "observation",
                                                      "measure", "band", "reliability", "sections_total")},
                                "doctype": "Scouting Alert", "stage": f"s{i}", "iso_week": "2031-W19",
                                "action": "Alarming", "status": "Open", "value": 1, "sections_scouted": 9})
            d.insert(ignore_permissions=True)
        rows = TC.open_alerts("Rose")
        self.assertGreater(len(rows), 500)
        self.assertEqual(rows[0].name, worst)

    def test_resolved_alerts_are_not_open(self):
        name = self.raise_spray_advised()
        frappe.db.set_value("Scouting Alert", name, "status", "Resolved")
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose")])
