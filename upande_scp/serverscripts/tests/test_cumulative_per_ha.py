"""Cumulative per-hectare figures and the once-per-round alert for block crops.

The pure rules run anywhere; the integration class writes throw-away Scouting
Entries into a March round that has no real data, mocks the mail send and the
commit, and rolls everything back.
"""

import unittest
from datetime import date
from unittest import mock

import frappe

from upande_scp.serverscripts.common import cumulative_rules as R


class TestRounds(unittest.TestCase):
    def test_a_week_round_is_the_iso_week(self):
        # 2026-10-07 is a Wednesday; the ISO week runs Mon 5th to Sun 11th.
        self.assertEqual(R.round_bounds(date(2026, 10, 7)), (date(2026, 10, 5), date(2026, 10, 11)))

    def test_boundaries_belong_to_their_own_round(self):
        self.assertEqual(R.round_bounds(date(2026, 10, 11))[0], date(2026, 10, 5))   # Sunday: last day
        self.assertEqual(R.round_bounds(date(2026, 10, 12))[0], date(2026, 10, 12))  # Monday: new round

    def test_round_spans_the_year_end(self):
        start, end = R.round_bounds(date(2026, 12, 31))
        self.assertEqual((start, end), (date(2026, 12, 28), date(2027, 1, 3)))
        self.assertEqual(R.round_bounds(date(2027, 1, 4))[0], date(2027, 1, 4))

    def test_other_round_lengths_tile_without_gaps(self):
        a = R.round_bounds(date(2026, 10, 7), 10)
        b = R.round_bounds(a[1] + (date(2026, 1, 2) - date(2026, 1, 1)), 10)
        self.assertEqual((a[1] - a[0]).days, 9)
        self.assertEqual(b[0], a[1] + (date(2026, 1, 2) - date(2026, 1, 1)))

    def test_junk_round_length_falls_back_to_a_week(self):
        for bad in (None, "", 0, -3, "abc", 400):
            self.assertEqual(R.clean_round_days(bad), 7, bad)


class TestPerHa(unittest.TestCase):
    def test_total_over_hectares(self):
        self.assertEqual(R.per_ha(9, 3.14), 2.87)

    def test_no_area_is_none_not_zero_or_a_crash(self):
        for area in (None, 0, "", -2, "x"):
            self.assertIsNone(R.per_ha(9, area), area)

    def test_formatting(self):
        self.assertEqual(R.fmt_per_ha(12.44), "12.4")
        self.assertEqual(R.fmt_per_ha(0.46), "0.46")
        self.assertEqual(R.fmt_per_ha(None), "—")
        self.assertEqual(R.fmt_count(2.0), "2")
        self.assertEqual(R.fmt_count(2.5), "2.5")


class TestTheUsersExample(unittest.TestCase):
    """Day one records 2, 2, 1, 3; on a later day 1 more tips the block over."""

    DAYS = [(date(2026, 10, 5), 2), (date(2026, 10, 6), 2), (date(2026, 10, 7), 1), (date(2026, 10, 8), 3),
            (date(2026, 10, 9), 1)]

    def rows(self, upto):
        return [{"date": d, "count": n} for d, n in self.DAYS[:upto]]

    def test_running_total_builds_day_by_day(self):
        series = R.daily_series(self.rows(5))
        self.assertEqual([s["count"] for s in series], [2, 2, 1, 3, 1])
        self.assertEqual([s["running"] for s in series], [2, 4, 5, 8, 9])

    def test_two_visits_the_same_day_are_one_day(self):
        series = R.daily_series([{"date": date(2026, 10, 5), "count": 2}, {"date": date(2026, 10, 5), "count": 1}])
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0]["running"], 3)

    def test_crosses_only_on_the_last_day(self):
        area, threshold = 3.0, 2.9   # 9 / 3.0 = 3.0 per ha passes; 8 / 3.0 = 2.67 does not
        self.assertIsNone(R.crossing_day(R.daily_series(self.rows(4)), area, threshold))
        self.assertEqual(R.crossing_day(R.daily_series(self.rows(5)), area, threshold), date(2026, 10, 9))

    def test_threshold_is_inclusive(self):
        self.assertEqual(R.crossing_day(R.daily_series(self.rows(5)), 3.0, 3.0), date(2026, 10, 9))

    def test_no_threshold_or_no_area_never_crosses(self):
        series = R.daily_series(self.rows(5))
        self.assertIsNone(R.crossing_day(series, 3.0, 0))
        self.assertIsNone(R.crossing_day(series, None, 1.0))


class TestDedupeRules(unittest.TestCase):
    def test_alerts_once(self):
        self.assertTrue(R.should_alert(3.0, 2.9, already_alerted=False))
        self.assertFalse(R.should_alert(3.4, 2.9, already_alerted=True))

    def test_below_threshold_unset_or_missing_area_does_not_alert(self):
        self.assertFalse(R.should_alert(2.0, 2.9, False))
        self.assertFalse(R.should_alert(3.0, 0, False))
        self.assertFalse(R.should_alert(None, 2.9, False))

    def test_key_is_stable_within_a_round_and_differs_between_rounds(self):
        a = R.alert_key("B1", "pest", "Mites", date(2026, 10, 5))
        self.assertEqual(a, R.alert_key("B1", "pest", "Mites", "2026-10-05"))
        self.assertNotEqual(a, R.alert_key("B1", "pest", "Mites", date(2026, 10, 12)))
        self.assertNotEqual(a, R.alert_key("B2", "pest", "Mites", date(2026, 10, 5)))
        self.assertNotEqual(a, R.alert_key("B1", "disease", "Mites", date(2026, 10, 5)))


# ── integration (site data; skips when a block / filter is missing) ──────────────────────────────────────────────

ROUND_1 = [date(2026, 3, 2), date(2026, 3, 3), date(2026, 3, 4), date(2026, 3, 5)]   # Mon-Thu
ROUND_2_DAY = date(2026, 3, 9)                                                          # next Monday
COUNTS = [2, 2, 1, 3]


class TestAlertOnRealBlock(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        from upande_scp.serverscripts.common import crop_catalog, stage_roles
        from upande_scp.serverscripts.scouting import cumulative_per_ha as C

        self.C = C
        self.crop = "Avocado"
        houses = [h for h in crop_catalog.greenhouses_for_crop(self.crop)
                  if frappe.db.get_value("Warehouse", h, "custom_area_ha")]
        if not houses:
            self.skipTest("no avocado block with an area on this site")
        self.block = houses[0]
        self.area = float(frappe.db.get_value("Warehouse", self.block, "custom_area_ha"))
        row = frappe.get_all("Pest Filter", filters={"crop_scouted": self.crop}, fields=["name", "pest"], limit=1)
        if not row:
            self.skipTest("no avocado pest filters")
        self.pf, self.pest = row[0]["name"], row[0]["pest"]
        roles = stage_roles.role_map()
        self.stage = next((s for s in ("Adult", "Larvae", "Nymph") if stage_roles.is_live(s, roles)), "Adult")
        self.scout = frappe.db.get_value("Scouting Entry", {"crop_scouted": self.crop}, "scouts_name")
        self.section = frappe.db.get_value("Pests Scouting Entry", {"parenttype": "Scouting Entry"}, "plant_section")

        self.real_recipients = C.recipients_for_block
        self.sent = []
        patches = [
            mock.patch("frappe.sendmail", side_effect=lambda **kw: self.sent.append(kw)),
            mock.patch.object(C, "recipients_for_block", return_value=["nobody@example.invalid"]),
            mock.patch("frappe.db.commit"),
            mock.patch("frappe.utils.nowdate", return_value="2026-03-06"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(frappe.db.rollback)

    def entry(self, day, count):
        frappe.get_doc({
            "doctype": "Scouting Entry", "naming_series": "SCE-.YYYY.-", "scouts_name": self.scout,
            "block": self.block, "crop_scouted": self.crop, "date_of_capture": day, "time_of_capture": "09:00:00",
            "pests_scouting_entry": [{"plant_section": self.section, "pest": self.pest, "stage": self.stage, "count": count}],
        }).insert(ignore_permissions=True, ignore_links=True, ignore_mandatory=True)

    def threshold(self, per_ha):
        frappe.db.set_value("Pest Filter", self.pf, "cumulative_per_ha_threshold", per_ha)

    def test_users_example_alerts_once_on_the_tipping_entry(self):
        # 2+2+1+3 = 8 stays under; the 1 that makes 9 passes.
        self.threshold((9 / self.area) - 0.001)
        for day, n in zip(ROUND_1, COUNTS):
            self.entry(day, n)
        self.threshold((9 / self.area) - 0.001)   # (the entries above are the sample)
        before = self.C.evaluate_block(self.block, ROUND_1[-1])
        self.assertEqual(before["passed"], [], "8 over the area is still under the threshold")
        self.assertEqual(self.sent, [])

        self.entry(date(2026, 3, 6), 1)
        after = self.C.evaluate_block(self.block, date(2026, 3, 6))
        self.assertEqual(after["sent"], [self.pest])
        self.assertEqual(len(self.sent), 1)
        self.assertIn(self.pest, self.sent[0]["subject"])
        self.assertIn(self.block, self.sent[0]["message"])
        self.assertIn("2 + 2 + 1 + 3 + 1 = 9", self.sent[0]["message"])

        # More scouting the same round: no second email.
        self.entry(date(2026, 3, 6), 4)
        self.C.evaluate_block(self.block, date(2026, 3, 6))
        self.assertEqual(len(self.sent), 1)

    def test_a_new_round_can_alert_again(self):
        self.threshold(0.01)
        self.entry(ROUND_1[0], 1)
        self.C.evaluate_block(self.block, ROUND_1[0])
        self.assertEqual(len(self.sent), 1)
        with mock.patch("frappe.utils.nowdate", return_value="2026-03-10"):
            self.entry(ROUND_2_DAY, 1)
            self.C.evaluate_block(self.block, ROUND_2_DAY)
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(frappe.db.count("Cumulative Pest Alert", {"warehouse": self.block, "observation": self.pest}), 2)

    def test_no_threshold_no_email(self):
        self.threshold(0)
        self.entry(ROUND_1[0], 50)
        self.assertEqual(self.C.evaluate_block(self.block, ROUND_1[0])["passed"], [])
        self.assertEqual(self.sent, [])

    def test_missing_area_is_skipped_with_a_reason_not_a_crash(self):
        self.threshold(0.01)
        self.entry(ROUND_1[0], 5)
        frappe.db.set_value("Warehouse", self.block, "custom_area_ha", 0)
        out = self.C.evaluate_block(self.block, ROUND_1[0])
        self.assertEqual(out["skipped"], "block has no area")
        self.assertEqual(self.sent, [])

    def test_a_late_sync_of_an_old_round_does_not_alert(self):
        self.threshold(0.01)
        self.entry(ROUND_1[0], 5)
        with mock.patch("frappe.utils.nowdate", return_value="2026-04-20"):
            self.assertEqual(self.C.evaluate_block(self.block, ROUND_1[0])["skipped"], "round is over")
        self.assertEqual(self.sent, [])

    def _eligible_user(self):
        """An enabled Active Employee of the block's company holding a recipient role."""
        company = self.C.block_company(self.block)
        if not company:
            self.skipTest("the block's farm has no company")
        users = frappe.get_all("Employee", filters={"company": company, "status": "Active", "user_id": ["is", "set"]}, pluck="user_id")
        hit = frappe.get_all("Has Role", filters={"parenttype": "User", "parent": ["in", users or [""]],
                                                  "role": ["in", list(self.C.RECIPIENT_ROLES)]}, pluck="parent")
        hit = [u for u in hit if frappe.db.get_value("User", u, "enabled")]
        if not hit:
            self.skipTest("no enabled spray-plan creator / manager employee in the block's company")
        return company, hit[0]

    def test_recipients_are_the_block_companys_creators_and_managers(self):
        company, user = self._eligible_user()
        with mock.patch.object(self.C, "recipients_for_block", self.real_recipients):
            got = self.C.recipients_for_block(self.block)
        email = frappe.db.get_value("User", user, "email") or user
        self.assertIn(email, got)
        employees = set(frappe.get_all("Employee", filters={"company": company, "user_id": ["is", "set"]}, pluck="user_id"))
        self.assertTrue(set(got) <= {frappe.db.get_value("User", u, "email") or u for u in employees},
                        "nobody outside the company is addressed")
        others = frappe.get_all("Employee", filters={"company": ["!=", company], "user_id": ["is", "set"]}, pluck="user_id")
        self.assertFalse(set(got) & set(others))
        # System-wide role holders who are not Employees of the company (e.g. head-office
        # General Managers) are never addressed: no generic fallback group.
        outsiders = set(frappe.get_all("Has Role", filters={"parenttype": "User", "role": ["in", list(self.C.RECIPIENT_ROLES)]}, pluck="parent")) - employees
        self.assertFalse(set(got) & {frappe.db.get_value("User", u, "email") or u for u in outsiders})

    def test_a_disabled_user_is_skipped(self):
        _company, user = self._eligible_user()
        frappe.db.set_value("User", user, "enabled", 0)
        with mock.patch.object(self.C, "recipients_for_block", self.real_recipients):
            self.assertNotIn(frappe.db.get_value("User", user, "email") or user, self.C.recipients_for_block(self.block))

    def test_a_farm_without_a_company_has_no_recipients(self):
        with mock.patch.object(self.C, "recipients_for_block", self.real_recipients), \
                mock.patch.object(self.C, "block_company", return_value=None):
            self.assertEqual(self.C.recipients_for_block(self.block), [])

    def test_a_rose_house_is_not_a_block_crop(self):
        house = frappe.db.get_value("Warehouse", {"warehouse_type": "Greenhouse", "custom_farm": ["is", "set"]})
        if house:
            self.assertIn("skipped", self.C.evaluate_block(house, ROUND_1[0]))

    def test_the_figure_counts_live_stages_only(self):
        """A Sign (damage) is not the pest."""
        self.threshold(0.01)
        self.entry(ROUND_1[0], 2)
        frappe.get_doc({
            "doctype": "Scouting Entry", "naming_series": "SCE-.YYYY.-", "scouts_name": self.scout,
            "block": self.block, "crop_scouted": self.crop, "date_of_capture": ROUND_1[0], "time_of_capture": "10:00:00",
            "pests_scouting_entry": [{"plant_section": self.section, "pest": self.pest, "stage": "Damages", "count": 40}],
        }).insert(ignore_permissions=True, ignore_links=True, ignore_mandatory=True)
        figs = self.C.round_figures(self.crop, [self.block], ROUND_1[0], date(2026, 3, 8))[self.block]
        mine = next(f for f in figs if f["observation"] == self.pest)
        self.assertEqual(mine["cumulative"], 2.0)

    def test_hook_only_enqueues(self):
        with mock.patch("frappe.enqueue") as enq:
            self.C.on_scouting_entry(frappe._dict(block=self.block, greenhouse=None, date_of_capture="2026-03-02"))
            enq.assert_called_once()
            self.assertTrue(enq.call_args.kwargs["deduplicate"])
            self.assertTrue(enq.call_args.kwargs["enqueue_after_commit"])
        with mock.patch("frappe.enqueue") as enq:
            self.C.on_scouting_entry(frappe._dict(block=None, greenhouse="GH 1", date_of_capture="2026-03-02"))
            enq.assert_not_called()   # a rose house entry costs nothing

    def test_hook_never_raises(self):
        with mock.patch("frappe.enqueue", side_effect=RuntimeError("redis down")):
            self.C.on_scouting_entry(frappe._dict(block=self.block, greenhouse=None, date_of_capture="2026-03-02"))
