"""Per-ha threshold in the Thresholds editor API, and the end-of-week block report email.

Integration tests against the site's real Lokitela avocado data; the mail send and the
commit are mocked and every write is rolled back.
"""
import unittest
from datetime import date, timedelta
from unittest import mock

import frappe

from upande_scp.serverscripts.reports import block_weekly_email as E
from upande_scp.serverscripts.scouting import cumulative_per_ha as C
from upande_scp.serverscripts.store import thresholds_api as T


class TestThresholdsApiPerHa(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.addCleanup(frappe.db.rollback)
        if not C.is_block_crop("Avocado"):
            self.skipTest("no avocado block crop on this site")
        self.pest = frappe.get_all("Pest Filter", filters={"crop_scouted": "Avocado"}, fields=["name", "pest"], limit=1)
        self.disease = frappe.get_all("Disease Filter", filters={"crop_scouted": "Avocado"}, fields=["name", "disease"], limit=1)
        if not (self.pest and self.disease):
            self.skipTest("no avocado filters")

    def payload(self, crop="Avocado", **per_ha):
        b = T.get_thresholds(crop)
        for key in ("pests", "diseases"):
            for r in b[key]:
                if r["row"] in per_ha:
                    r["cumulative_per_ha"] = per_ha[r["row"]]
        return b

    def test_block_crop_rows_carry_the_line_and_round_trip(self):
        b = T.get_thresholds("Avocado")
        self.assertTrue(b["per_ha"])
        self.assertTrue(all("cumulative_per_ha" in r for r in b["pests"] + b["diseases"]))
        p, d = self.pest[0]["name"], self.disease[0]["name"]
        with mock.patch("frappe.db.commit"):
            T.save_thresholds("Avocado", self.payload(**{p: 7.5, d: 2.25}))
        after = T.get_thresholds("Avocado")
        self.assertEqual(next(r for r in after["pests"] if r["row"] == p)["cumulative_per_ha"], 7.5)
        self.assertEqual(next(r for r in after["diseases"] if r["row"] == d)["cumulative_per_ha"], 2.25)
        # and the engine reads what the editor wrote
        self.assertEqual(C.thresholds("Avocado")[("pest", self.pest[0]["pest"])], 7.5)

    def test_blank_clears_and_junk_is_refused(self):
        p = self.pest[0]["name"]
        with mock.patch("frappe.db.commit"):
            T.save_thresholds("Avocado", self.payload(**{p: 0}))
        self.assertNotIn(("pest", self.pest[0]["pest"]), C.thresholds("Avocado"))
        for bad in (-1, "abc", float("inf")):
            with self.assertRaises(frappe.ValidationError):
                T.save_thresholds("Avocado", self.payload(**{p: bad}))

    def test_a_crop_that_is_not_block_grown_has_no_line_and_ignores_it(self):
        roses = [c for c in T.list_crops() if c and not C.is_block_crop(c)]
        if not roses:
            self.skipTest("no non-block crop")
        b = T.get_thresholds(roses[0])
        self.assertFalse(b["per_ha"])
        self.assertTrue(all("cumulative_per_ha" not in r for r in b["pests"] + b["diseases"]))
        if b["pests"]:
            row = b["pests"][0]
            row["cumulative_per_ha"] = 9
            with mock.patch("frappe.db.commit"):
                T.save_thresholds(roses[0], b)
            self.assertEqual(float(frappe.db.get_value("Pest Filter", row["row"], "cumulative_per_ha_threshold") or 0), 0)


class TestWeeklyEmail(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.addCleanup(frappe.db.rollback)
        self.crop = "Avocado"
        farms = E.farms_for(self.crop) if C.is_block_crop(self.crop) else []
        if not farms:
            self.skipTest("no avocado farm with blocks")
        self.farm = farms[0]
        wk = frappe.db.sql("select max(date_of_capture) from `tabScouting Entry` where crop_scouted=%s", self.crop)[0][0]
        if not wk:
            self.skipTest("no avocado scouting")
        self.monday = wk - timedelta(days=wk.weekday())
        self.sent = []
        for p in (
            mock.patch("frappe.sendmail", side_effect=lambda **kw: self.sent.append(kw)),
            mock.patch("frappe.db.commit"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def test_last_week_monday(self):
        self.assertEqual(E.last_week_monday(date(2026, 11, 2)), date(2026, 10, 26))   # a Monday
        self.assertEqual(E.last_week_monday(date(2026, 11, 8)), date(2026, 10, 26))   # a Sunday

    def test_one_email_per_farm_to_the_farm_recipients_with_the_workbook(self):
        with mock.patch.object(C, "recipients_for_farm", return_value=["a@example.invalid", "b@example.invalid"]), \
                mock.patch.object(E.W, "build_workbook_bytes", return_value=b"PK-xlsx"):
            out = E.send_weekly_block_report(self.monday + timedelta(days=7))
        mine = [o for o in out if o["farm"] == self.farm]
        self.assertEqual(len(mine), 1)
        self.assertEqual(len(self.sent), len(out))
        mail = next(m for m in self.sent if self.farm in m["subject"])
        self.assertEqual(mail["recipients"], ["a@example.invalid", "b@example.invalid"])
        self.assertEqual(mail["attachments"][0]["fcontent"], b"PK-xlsx")
        self.assertTrue(mail["attachments"][0]["fname"].endswith(".xlsx"))
        self.assertIn("Weekly report", mail["message"])

    def test_a_paused_crop_sends_nothing(self):
        with mock.patch.object(C, "alerts_enabled", return_value=False), \
                mock.patch.object(C, "recipients_for_farm", return_value=["a@example.invalid"]):
            out = E.send_weekly_block_report(self.monday + timedelta(days=7))
        self.assertEqual(out, [])
        self.assertEqual(self.sent, [])

    def test_a_farm_with_nobody_to_tell_sends_nothing(self):
        with mock.patch.object(C, "recipients_for_farm", return_value=[]):
            self.assertEqual(E.send_farm(self.crop, self.farm, self.monday)["reason"], "no recipients")
        self.assertEqual(self.sent, [])

    def test_over_threshold_rows_are_flagged_and_rendered(self):
        data = E.collect(self.crop, self.farm, self.monday)
        figs = [f for r in data["rows"] for f in r["figures"]]
        if not figs:
            self.skipTest("no per-ha threshold is set on this site's block crop")
        self.assertEqual(data["over"], sum(f["per_ha"] >= f["threshold_per_ha"] for f in figs))
        html = E.render(data)
        self.assertEqual(html.count(">Over<"), data["over"])
        self.assertNotIn("border-left", html)

    def test_a_forced_crossing_is_over_and_a_sent_alert_is_listed(self):
        block = next(b for b in E.W._blocks_for_farm(self.farm) if C.block_info([b])[b]["area_ha"])
        pf = frappe.get_all("Pest Filter", filters={"crop_scouted": self.crop}, fields=["name", "pest"], limit=1)[0]
        frappe.db.set_value("Pest Filter", pf["name"], "cumulative_per_ha_threshold", 0.1)
        from upande_scp.serverscripts.common import stage_roles
        roles = stage_roles.role_map()
        stage = next((s for s in ("Adult", "Larvae", "Nymph") if stage_roles.is_live(s, roles)), "Adult")
        scout = frappe.db.get_value("Scouting Entry", {"crop_scouted": self.crop}, "scouts_name")
        sec = frappe.db.get_value("Pests Scouting Entry", {"parenttype": "Scouting Entry"}, "plant_section")
        frappe.get_doc({
            "doctype": "Scouting Entry", "naming_series": "SCE-.YYYY.-", "scouts_name": scout, "block": block,
            "crop_scouted": self.crop, "date_of_capture": self.monday, "time_of_capture": "09:00:00",
            "pests_scouting_entry": [{"plant_section": sec, "pest": pf["pest"], "stage": stage, "count": 5}],
        }).insert(ignore_permissions=True, ignore_links=True, ignore_mandatory=True)
        frappe.get_doc({
            "doctype": C.DOCTYPE, "crop": self.crop, "farm": self.farm, "warehouse": block, "kind": "pest",
            "observation": pf["pest"], "round_start": self.monday, "round_end": self.monday + timedelta(days=6),
            "cumulative": 5, "area_ha": 1, "per_ha": 5, "threshold_per_ha": 0.1, "crossed_on": self.monday,
            "status": "Sent",
        }).insert(ignore_permissions=True)
        data = E.collect(self.crop, self.farm, self.monday)
        row = next(r for r in data["rows"] if r["block"] == block)
        self.assertTrue(next(f for f in row["figures"] if f["observation"] == pf["pest"])["over"])
        self.assertEqual(len(data["alerts"]), 1)
        self.assertIn(pf["pest"], E.render(data))

    def test_blocks_without_an_area_are_named(self):
        block = E.W._blocks_for_farm(self.farm)[0]
        frappe.db.set_value("Warehouse", block, "custom_area_ha", 0)
        data = E.collect(self.crop, self.farm, self.monday)
        self.assertIn(block, data["no_area"])
        self.assertIn("No area set", E.render(data))

    def test_test_send_goes_to_one_address_only_and_needs_a_role(self):
        with mock.patch.object(E.W, "build_workbook_bytes", return_value=b"x"):
            r = E.send_farm(self.crop, self.farm, self.monday, only_to="me@example.invalid")
        self.assertTrue(r["sent"])
        self.assertEqual(self.sent[0]["recipients"], ["me@example.invalid"])
        self.assertTrue(self.sent[0]["subject"].startswith("[Test]"))
        frappe.set_user("Guest")
        try:
            with self.assertRaises(frappe.PermissionError):
                E.preview_weekly_block_email(self.crop)
        finally:
            frappe.set_user("Administrator")
