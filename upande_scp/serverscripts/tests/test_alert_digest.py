"""The 17:00 EAT scouting-alert digest (thresholds spec §3, D4). DB test — direct
runner; frappe.sendmail is mocked in every test that could reach it."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

import frappe

from upande_scp.serverscripts.scouting import alert_digest as D
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import thresholds_fixture as TF
from upande_scp.serverscripts.tests.test_scouting_alerts import (
    SUN_20, U_APPROVER, U_CREATOR, U_GM, U_SUPER, AlertCase, at,
)


class TestDigest(AlertCase):
    def setUp(self):
        super().setUp()
        self.gate = f"{D.DIGEST_GATE_PREFIX}:lock"
        TC.clear_gate(self.gate)
        self._clear_markers()
        self.commit = patch.object(frappe.db, "commit")
        self.commit.start()

    @staticmethod
    def _clear_markers():
        # The marker is DB-backed but frappe.defaults also caches it in Redis,
        # which a test rollback does not undo.
        for user in (U_CREATOR, U_SUPER, U_APPROVER, U_GM):
            frappe.defaults.clear_user_default(D.DIGEST_MARKER, user)

    def tearDown(self):
        self.commit.stop()
        self._clear_markers()
        TC.clear_gate(self.gate)
        super().tearDown()

    def _two_alerts(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")                                    # Thrips 33.3 %
        TF.seed_week(self.gh2, TF.WEEK_20[0], crop="Rose", pest="Aphids", stage="Singles")   # Aphids 33.3 %
        TF.set_bands("Rose", "Thrips", 0, 10, 30)      # → Spray advised
        TF.set_bands("Rose", "Aphids", 0, 30, 60)      # → Alarming
        TC.check_crop("Rose", SUN_20)

    def test_one_email_per_recipient_listing_their_alerts(self):
        self._two_alerts()
        digests = D.build_digests(at(SUN_20, 17, 5))
        self.assertEqual(sorted(a.observation for a in digests[U_CREATOR]), ["Aphids", "Thrips"])
        self.assertEqual([a.observation for a in digests[U_APPROVER]], ["Thrips"])   # Alarming is not theirs (D4)
        with patch.object(frappe, "sendmail") as sendmail:
            out = D.send_alert_digest(at(SUN_20, 17, 5))
        self.assertEqual((sendmail.call_count, out["sent"]), (4, 4))
        by_to = {c.kwargs["recipients"][0]: c.kwargs for c in sendmail.call_args_list}
        self.assertEqual(set(by_to), {U_CREATOR, U_SUPER, U_APPROVER, U_GM})
        self.assertTrue(by_to[U_CREATOR]["subject"].endswith("(2)"))
        self.assertTrue(by_to[U_APPROVER]["subject"].endswith("(1)"))
        self.assertIn("Spray advised", by_to[U_CREATOR]["message"])
        self.assertIn("33.3%", by_to[U_CREATOR]["message"])

    def test_no_open_alert_today_means_no_email(self):
        with patch.object(frappe, "sendmail") as sendmail:
            out = D.send_alert_digest(at(SUN_20, 17, 5))
        sendmail.assert_not_called()
        self.assertEqual(out["sent"], 0)

    def test_acknowledged_and_resolved_alerts_are_left_out(self):
        self._two_alerts()
        names = frappe.get_all("Scouting Alert", filters={"iso_week": "2031-W20"}, pluck="name")
        frappe.db.set_value("Scouting Alert", names[0], "status", "Acknowledged")
        for name in names[1:]:
            frappe.db.set_value("Scouting Alert", name, "status", "Resolved")
        self.assertEqual(D.build_digests(at(SUN_20, 17, 5)), {})

    def test_the_digest_follows_nairobi_time_not_the_site_or_server_clock(self):
        self._two_alerts()
        with patch.object(frappe, "sendmail") as sendmail:
            early = D.send_alert_digest(at(SUN_20, 16, 59))
            # 17:00 on kaitet.local's own System Settings clock (Asia/Kolkata) is 14:30 EAT.
            site_17 = D.send_alert_digest(datetime(2031, 5, 18, 17, 0, tzinfo=ZoneInfo("Asia/Kolkata")))
            # 14:05 UTC — the server's clock — is 17:05 EAT.
            utc_14 = D.send_alert_digest(datetime(2031, 5, 18, 14, 5, tzinfo=timezone.utc))
        self.assertEqual(early, {"skipped": "not the send hour", "hour": 16})
        self.assertEqual(site_17, {"skipped": "not the send hour", "hour": 14})  # 14:00 EAT sends nothing
        self.assertEqual(utc_14["sent"], 4)
        self.assertEqual(sendmail.call_count, 4)
        self.clock.stop()
        try:
            self.assertEqual(TC.now_eat().utcoffset(), timedelta(hours=3))
        finally:
            self.clock.start()

    def test_twice_in_the_hour_sends_once(self):
        self._two_alerts()
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(SUN_20, 17, 5))
            again = D.send_alert_digest(at(SUN_20, 17, 50))
        self.assertEqual((again["sent"], sendmail.call_count), (0, 4))

    def test_marker_is_persisted_so_a_cache_flush_cannot_resend(self):
        self._two_alerts()
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(SUN_20, 17, 5))
            TC.clear_gate(self.gate)
            frappe.cache().delete_value(f"{D.DIGEST_GATE_PREFIX}:2031-05-18")
            again = D.send_alert_digest(at(SUN_20, 17, 40))
        self.assertEqual((again["sent"], sendmail.call_count), (0, 4))

    def test_a_run_at_19_after_a_missed_17_sends(self):
        self._two_alerts()
        with patch.object(frappe, "sendmail") as sendmail:
            out = D.send_alert_digest(at(SUN_20, 19, 0))
        self.assertEqual((out["sent"], sendmail.call_count), (4, 4))

    def test_a_failing_recipient_does_not_block_others_and_is_retried(self):
        self._two_alerts()
        real = D.render
        def flaky(alerts, day):
            if len(alerts) == 1:       # the approver's and GM's digests
                raise ValueError("boom")
            return real(alerts, day)
        with patch.object(frappe, "sendmail") as sendmail, patch.object(D, "render", flaky), \
                patch.object(frappe, "log_error"):
            first = D.send_alert_digest(at(SUN_20, 17, 5))
        self.assertEqual((first["sent"], sorted(first["failed"])), (2, sorted([U_APPROVER, U_GM])))
        self.assertEqual(sendmail.call_count, 2)
        with patch.object(frappe, "sendmail") as sendmail:
            second = D.send_alert_digest(at(SUN_20, 18, 5))
        self.assertEqual((second["sent"], sendmail.call_count), (2, 2))
        self.assertEqual({c.kwargs["recipients"][0] for c in sendmail.call_args_list}, {U_APPROVER, U_GM})

    def test_a_single_section_figure_says_too_clustered_to_judge(self):
        self._two_alerts()
        frappe.db.sql("UPDATE `tabScouting Alert` SET margin = 0, sections_scouted = 1 WHERE iso_week = '2031-W20'")
        rows = D.build_digests(at(SUN_20, 17, 5))[U_CREATOR]
        self.assertIn("too clustered to judge", D.render(rows, SUN_20))

    def test_a_stale_user_permission_does_not_stop_the_digest(self):
        # kaitet.local has User Permissions pointing at deleted doctypes; the
        # permission machinery raises DoesNotExistError on them. Reading the
        # marker must not go through it, and one bad user must not stop others.
        self._two_alerts()
        frappe.db.sql(
            """insert into `tabUser Permission` (name, creation, modified, owner, modified_by,
               docstatus, idx, user, allow, for_value, is_default, apply_to_all_doctypes)
               values (%s, now(), now(), 'Administrator', 'Administrator', 0, 0, %s,
               '_Deleted Doctype SCP', 'x', 0, 1)""",
            ("_TEST-UP-" + frappe.generate_hash(length=8), U_APPROVER),
        )
        frappe.cache.hdel("user_permissions", U_APPROVER)
        try:
            with patch.object(frappe, "sendmail") as sendmail, patch.object(frappe, "log_error"):
                out = D.send_alert_digest(at(SUN_20, 17, 5))
        finally:
            frappe.cache.hdel("user_permissions", U_APPROVER)
        self.assertEqual({c.kwargs["recipients"][0] for c in sendmail.call_args_list},
                         {U_CREATOR, U_SUPER, U_APPROVER, U_GM})
        self.assertEqual(out["sent"], 4)

    def test_an_alert_raised_after_the_days_digest_goes_out_the_next_day_once(self):
        self._two_alerts()                                   # raised 09:00 EAT
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(SUN_20, 17, 5))
        self.assertEqual(sendmail.call_count, 4)
        # 18:30 the same day: a new Spray advised alert on another key
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", pest="Aphids", stage="Singles")
        self.clock.stop()
        with patch.object(TC, "now_eat", return_value=at(SUN_20, 18, 30)):
            TC.check_crop("Rose", SUN_20)
        self.clock.start()
        late = TC.alert_name(self.gh, "Pest", "Aphids", "", "2031-W20")
        self.assertEqual(str(frappe.db.get_value("Scouting Alert", late, "raised_at")), "2031-05-18 18:30:00")
        mon, tue = SUN_20 + timedelta(days=1), SUN_20 + timedelta(days=2)
        with patch.object(frappe, "sendmail") as sendmail:
            same_day = D.send_alert_digest(at(SUN_20, 19, 0))
            next_day = D.send_alert_digest(at(mon, 17, 5))
            TC.clear_gate(self.gate)
            day_after = D.send_alert_digest(at(tue, 17, 5))
        self.assertEqual(same_day["sent"], 0)                # one email per person per day
        by_to = {c.kwargs["recipients"][0]: c.kwargs for c in sendmail.call_args_list}
        self.assertEqual(sendmail.call_count, 2)             # Alarming → creator + supervisor only
        self.assertEqual(set(by_to), {U_CREATOR, U_SUPER})
        self.assertTrue(by_to[U_CREATOR]["subject"].endswith("(1)"))
        self.assertIn("Aphids", by_to[U_CREATOR]["message"])
        self.assertNotIn("Thrips", by_to[U_CREATOR]["message"])   # already in yesterday's digest
        self.assertEqual((next_day["sent"], day_after["sent"]), (2, 0))

    def test_a_reopened_dead_plan_alert_appears_in_the_next_digest(self):
        from upande_scp.serverscripts.tests.test_scouting_alerts import dead_plan
        self._two_alerts()
        with patch.object(frappe, "sendmail"):
            D.send_alert_digest(at(SUN_20, 17, 5))
        name = TC.alert_name(self.gh, "Pest", "Thrips", "", "2031-W20")
        frappe.db.set_value("Scouting Alert", name, {"status": "Converted to plan", "work_order": dead_plan()})
        self.clock.stop()
        with patch.object(TC, "now_eat", return_value=at(SUN_20, 18, 30)):
            TC.check_crop("Rose", SUN_20)
        self.clock.start()
        mon = SUN_20 + timedelta(days=1)
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(mon, 17, 5))
        by_to = {c.kwargs["recipients"][0]: c.kwargs for c in sendmail.call_args_list}
        self.assertIn("Thrips", by_to[U_CREATOR]["message"])
        self.assertNotIn("Aphids", by_to[U_CREATOR]["message"])

    def test_a_first_ever_digest_covers_the_last_24_hours(self):
        self._two_alerts()                                   # raised Sun 09:00
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(SUN_20 + timedelta(days=1), 17, 5))   # Mon 17:05: 32 h later
        sendmail.assert_not_called()

    def test_a_hot_spot_reaches_the_digest_with_its_label(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], hot_infested=5, others_infested=2)   # house Alarming + hot spot
        TC.check_crop("Rose", SUN_20)
        digests = D.build_digests(at(SUN_20, 17, 5))
        self.assertEqual([(a.alert_type, a.action) for a in digests[U_CREATOR]],
                         [("House", "Alarming"), ("Hot spot", "Hot spot")])     # each once, house first
        self.assertNotIn(U_APPROVER, digests)
        html = D.render(digests[U_CREATOR], SUN_20)
        self.assertIn(f"{self.gh} · first beds · front", html)
        self.assertIn("100.0% <span style='color:#777'>(house 46.7%) · 5 zones in this section</span>", html)
        self.assertIn("Hot spot means one part of the house is clearly worse", html)
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(SUN_20, 17, 5))
        self.assertEqual(sorted(c.kwargs["recipients"][0] for c in sendmail.call_args_list),
                         sorted([U_CREATOR, U_SUPER]))
        self.assertTrue(all(c.kwargs["subject"].endswith("(2)") for c in sendmail.call_args_list))
