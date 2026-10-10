"""Hot spots (piece 3b): keys, evaluation, alerts, surfaces and the grid.
DB test — direct runner; rolled back in tearDown. Reuses 3a's AlertCase (its
committed _test_scp_alert_* users, rosters, patched GMs and EAT clock)."""

import hashlib
import unittest
from datetime import date, datetime
from unittest.mock import patch

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import thresholds_fixture as TF
from upande_scp.serverscripts.tests.test_scouting_alerts import (
    SUN_20, U_APPROVER, U_CREATOR, U_GM, U_SUPER, AlertCase, at,
)

LABEL = "first beds · front"
SPOT_FIELDS = ["name", "alert_type", "section_row", "section_col", "section_label", "action", "band",
               "value", "margin", "reliability", "sections_scouted", "status", "notified_band",
               "notified_action", "notified", "raised_at"]


class HotCase(AlertCase):
    def spot(self, gh=None, week="2031-W20", row=0, col=0, obs="Thrips", stage="", kind="Pest"):
        return frappe.db.get_value(
            "Scouting Alert", TC.alert_name(gh or self.gh, kind, obs, stage, week, B.HOT_SPOT, row, col),
            SPOT_FIELDS, as_dict=True,
        )

    def scouting_told(self, user):
        """Every scouting notification this user got for a test-week alert."""
        return frappe.db.count("Notification Log", {
            "for_user": user, "document_type": "Scouting Alert", "scp_category": "scouting",
            "document_name": ["like", "SA-2031-%"],
        })

    def raw_alert(self, alert_type, row, col, week="2031-W20", status="Open", **extra):
        """A rolled-back Scouting Alert row for the SQL-level key tests."""
        doc = frappe.get_doc({
            "doctype": "Scouting Alert", "crop": "Rose", "farm": self.farm, "warehouse": self.gh,
            "kind": "Pest", "observation": "Thrips", "stage": "", "iso_week": week,
            "alert_type": alert_type, "section_row": row, "section_col": col,
            "measure": "Percentage", "value": 50, "band": "High", "status": status,
            "action": "Hot spot" if alert_type == B.HOT_SPOT else "Spray advised", **extra,
        }).insert(ignore_permissions=True)
        return doc.name


class TestKeys(HotCase):
    def test_house_names_hash_exactly_as_before(self):
        # Golden value from HEAD c8a86de's formula: no existing alert is renamed.
        self.assertEqual(TC.alert_name("Chepsito GH 01 - KR", "Pest", "Thrips", "", "2031-W20"),
                         "SA-2031-W20-3d9f56269e")
        self.assertEqual(TC.alert_name("Chepsito GH 01 - KR", "Pest", "Thrips", "Adult", "2031-W20"),
                         "SA-2031-W20-1c6c7b72aa")
        self.assertEqual(TC.alert_name("Chepsito GH 01 - KR", "Pest", "Thrips", "", "2031-W20", B.HOUSE, -1, -1),
                         "SA-2031-W20-3d9f56269e")

    def test_a_hot_spot_key_is_its_own_name_per_section(self):
        spot = TC.alert_name("Chepsito GH 01 - KR", "Pest", "Thrips", "", "2031-W20", B.HOT_SPOT, 0, 0)
        self.assertEqual(spot, "SA-2031-W20-51eb3a0af5")
        self.assertNotEqual(spot, TC.alert_name("Chepsito GH 01 - KR", "Pest", "Thrips", "", "2031-W20",
                                                B.HOT_SPOT, 0, 1))

    def test_a_house_doc_without_type_keeps_its_old_name(self):
        doc = frappe.get_doc({
            "doctype": "Scouting Alert", "crop": "Rose", "warehouse": self.gh, "kind": "Pest",
            "observation": "Thrips", "stage": "", "iso_week": "2031-W20", "status": "Open",
        }).insert(ignore_permissions=True)
        expected = "SA-2031-W20-" + hashlib.sha1(f"{self.gh}|Pest|Thrips||2031-W20".encode()).hexdigest()[:10]
        self.assertEqual(doc.name, expected)
        self.assertEqual((doc.alert_type, doc.section_row, doc.section_col), ("House", -1, -1))
        spot = self.raw_alert(B.HOT_SPOT, 2, 1)
        self.assertEqual(spot, TC.alert_name(self.gh, "Pest", "Thrips", "", "2031-W20", B.HOT_SPOT, 2, 1))

    def test_old_rows_read_as_house_with_no_section(self):
        # What every pre-3b row got when the columns were added (column DEFAULTs).
        frappe.db.sql("""insert into `tabScouting Alert` (name, crop, warehouse, kind, observation, iso_week, status)
                         values ('_TEST-SA-OLD', 'Rose', %s, 'Pest', 'Thrips', '2031-W20', 'Open')""", (self.gh,))
        row = frappe.db.get_value("Scouting Alert", "_TEST-SA-OLD",
                                  ["alert_type", "section_row", "section_col", "notified_band"], as_dict=True)
        self.assertEqual((row.alert_type, row.section_row, row.section_col, row.notified_band or None),
                         ("House", -1, -1, None))

    def test_resolve_touches_only_its_own_type_and_section(self):
        house = self.raw_alert(B.HOUSE, -1, -1)
        spot = self.raw_alert(B.HOT_SPOT, 0, 0)
        other = self.raw_alert(B.HOT_SPOT, 0, 1)
        base = {"warehouse": self.gh, "kind": "pest", "observation": "Thrips", "stage": "", "iso_week": "2031-W20"}
        TC._resolve(TC._key_params(base), include_week=True)                       # a House finding
        self.assertEqual([frappe.db.get_value("Scouting Alert", n, "status") for n in (house, spot, other)],
                         ["Resolved", "Open", "Open"])
        TC._resolve(TC._key_params({**base, "alert_type": B.HOT_SPOT, "section_row": 0, "section_col": 0}),
                    include_week=True)
        self.assertEqual([frappe.db.get_value("Scouting Alert", n, "status") for n in (spot, other)],
                         ["Resolved", "Open"])

    def test_previous_live_never_crosses_types(self):
        self.raw_alert(B.HOT_SPOT, 0, 0, notified_band="High")
        house_w21 = {"warehouse": self.gh, "kind": "pest", "observation": "Thrips", "stage": "",
                     "iso_week": "2031-W21"}
        self.assertIsNone(TC._previous_live(TC._key_params(house_w21), "2031-W20"))
        spot_w21 = {**house_w21, "alert_type": B.HOT_SPOT, "section_row": 0, "section_col": 0}
        self.assertEqual(TC._previous_live(TC._key_params(spot_w21), "2031-W20").notified_band, "High")

    def test_finding_and_row_keys_agree(self):
        name = self.raw_alert(B.HOT_SPOT, 1, 2)
        row = frappe.db.get_value("Scouting Alert", name, ["warehouse", "kind", "observation", "stage",
                                                            "alert_type", "section_row", "section_col"], as_dict=True)
        finding = {"warehouse": self.gh, "kind": "pest", "observation": "Thrips", "stage": "",
                   "iso_week": "2031-W20", "alert_type": B.HOT_SPOT, "section_row": 1, "section_col": 2}
        self.assertEqual(TC._row_key(row), TC.finding_key(finding))
        self.assertEqual(TC.finding_key({**finding, "alert_type": None})[4:], (B.HOUSE, -1, -1))


class TestHotSpots(HotCase):
    """Bands 5 / 20 / 50 unless a test says otherwise. seed_hot_section's default:
    corner (0, 0) 4 of 5 = 80 % (High), the other 8 sections 0 of 5 → the house
    reads 80 / 9 = 8.9 % (Low)."""

    def test_a_hot_section_in_a_low_house_raises_one_hot_spot_for_the_alarming_audience(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0])
        TC.check_crop("Rose", SUN_20)
        self.assertIsNone(self.alert())                                    # the house is Low: no house alert
        s = self.spot()
        self.assertEqual(
            (s.alert_type, s.action, s.band, s.value, s.reliability, s.sections_scouted, s.section_label,
             s.status, s.notified_band, s.notified_action or None),
            ("Hot spot", "Hot spot", "High", 80.0, "Fair", 5, LABEL, "Open", "High", None),
        )
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "alert_type": "Hot spot"}), 1)
        self.assertEqual([self.told(u, s.name) for u in (U_CREATOR, U_SUPER, U_APPROVER, U_GM)], [1, 1, 0, 0])
        subject = frappe.db.get_value("Notification Log", {"document_name": s.name, "for_user": U_CREATOR}, "subject")
        self.assertEqual(subject, f"Hot spot in {self.gh}, {LABEL}: Thrips 80.0% (house 8.9%) — "
                                  "high infestation in this area, stay alert")
        TC.check_crop("Rose", SUN_20)                                      # the next hour: silent
        self.assertEqual(self.told(U_CREATOR, s.name), 1)

    def test_the_house_alert_written_by_the_check_keeps_its_old_name(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], others_infested=2)    # house 44.4 % Moderate
        TC.check_crop("Rose", SUN_20)
        old = "SA-2031-W20-" + hashlib.sha1(f"{self.gh}|Pest|Thrips||2031-W20".encode()).hexdigest()[:10]
        self.assertEqual(frappe.db.get_value("Scouting Alert", old, ["alert_type", "action"]), ("House", "Alarming"))

    def test_a_section_rising_from_moderate_to_high_is_announced_again(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 70)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], hot_infested=2)       # corner 40 % Moderate, house 4.4 %
        TC.check_crop("Rose", SUN_20)
        s = self.spot()
        self.assertEqual((s.band, s.notified_band, self.told(U_CREATOR, s.name)), ("Moderate", "Moderate", 1))
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], hot_infested=4)       # corner 80 % High, house 8.9 % Low
        TC.check_crop("Rose", SUN_20)
        s = self.spot()
        self.assertEqual((s.band, s.notified_band, self.told(U_CREATOR, s.name)), ("High", "High", 2))
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.told(U_CREATOR, s.name), 2)

    def test_the_house_rising_to_the_sections_band_resolves_the_hot_spot(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0])
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.spot().status, "Open")
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], others_infested=5)    # house 97.8 % High = corner's band
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.spot().status, "Resolved")
        self.assertEqual(self.alert().action, "Spray advised")             # the house now speaks for itself

    def _house_and_spot(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], hot_infested=5, others_infested=2)  # corner 100 %, house 46.7 %
        TC.check_crop("Rose", SUN_20)
        found = [f for f in TC.evaluate("Rose", SUN_20) if f["warehouse"] == self.gh and not f["stage"]]
        house = next(f for f in found if f["alert_type"] == "House")
        spot = next(f for f in found if f["alert_type"] == "Hot spot" and f["action"])
        return house, spot

    def test_house_and_hot_spot_raised_together_notify_once_each(self):
        house, spot = self._house_and_spot()
        self.assertEqual((house["action"], spot["action"], spot["band"]), ("Alarming", "Hot spot", "high"))
        h, s = self.alert(), self.spot()
        self.assertEqual((self.told(U_CREATOR, h.name), self.told(U_CREATOR, s.name)), (1, 1))
        self.assertEqual(self.scouting_told(U_CREATOR), 2)
        self.assertEqual(self.scouting_told(U_APPROVER), 0)                 # Alarming + Hot spot: not theirs
        TC.check_crop("Rose", SUN_20)
        self.assertEqual((self.scouting_told(U_CREATOR), self.scouting_told(U_SUPER)), (2, 2))

    def test_a_clean_house_reading_never_resolves_a_hot_spot(self):
        house, _spot = self._house_and_spot()
        TC.upsert({**house, "band": "", "action": None, "reliability": "Good"}, at(SUN_20, 10))
        self.assertEqual((self.alert().status, self.spot().status), ("Resolved", "Open"))

    def test_a_cooled_section_never_resolves_the_house_alert(self):
        _house, spot = self._house_and_spot()
        TC.upsert({**spot, "band": "high", "action": None, "reliability": "Fair"}, at(SUN_20, 10))
        self.assertEqual((self.spot().status, self.alert().status), ("Resolved", "Open"))

    def test_unscouted_sections_neither_raise_nor_resolve(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], others={(1, 1)})      # 2 sections scouted, 7 not
        found = [f for f in TC.evaluate("Rose", SUN_20)
                 if f["warehouse"] == self.gh and f["alert_type"] == "Hot spot" and not f["stage"]]
        self.assertEqual(sorted((f["section_row"], f["section_col"], bool(f["action"])) for f in found),
                         [(0, 0, True), (1, 1, False)])
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "alert_type": "Hot spot"}), 1)

    def test_a_thin_section_reading_does_not_resolve_last_weeks_hot_spot(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0])
        TC.check_crop("Rose", SUN_20)
        w20 = self.spot()
        mon = date(2031, 5, 19)
        self.clock.stop()
        self.clock = patch.object(TC, "now_eat", return_value=at(mon, 10))
        self.clock.start()
        TF.seed_hot_section(self.gh, "2031-05-19", hot_infested=0, per_section=3)   # corner 0 of 3: thin
        TC.check_crop("Rose", mon)
        self.assertEqual(frappe.db.get_value("Scouting Alert", w20.name, "status"), "Open")
        TF.seed_hot_section(self.gh, "2031-05-20", hot_infested=0)                  # corner 0 of 5: Fair
        TC.check_crop("Rose", date(2031, 5, 20))
        self.assertEqual(frappe.db.get_value("Scouting Alert", w20.name, "status"), "Resolved")

    def test_next_weeks_hot_spot_in_the_same_section_is_carried_silently(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0])
        TC.check_crop("Rose", SUN_20)
        TF.seed_hot_section(self.gh, TF.WEEK_21[0])
        TC.check_crop("Rose", date(2031, 5, 25))
        w21 = self.spot(week="2031-W21")
        self.assertEqual((w21.notified_band, self.told(U_CREATOR, w21.name)), ("High", 0))
        self.assertEqual(self.spot().status, "Resolved")                    # superseded

    def test_an_avocado_block_names_rows(self):
        block = F.avocado_block()
        farm = frappe.db.get_value("Warehouse", block, "custom_farm")
        TF.clear_all_bands("Avocado")
        TF.set_roster(farm, "creators", [U_CREATOR])
        TF.set_roster(farm, "supervisors", [U_SUPER])
        TF.set_bands("Avocado", "Mealybugs", 5, 20, 50)
        TF.seed_hot_section(block, TF.WEEK_20[0], crop="Avocado", pest="Mealybugs", stage="Singles", block=True)
        TC.check_crop("Avocado", SUN_20)
        s = self.spot(gh=block, obs="Mealybugs")
        self.assertEqual((s.section_label, s.value, s.sections_scouted), ("first rows · front", 80.0, 5))
        subject = frappe.db.get_value("Notification Log", {"document_name": s.name, "for_user": U_CREATOR}, "subject")
        self.assertIn(f"Hot spot in {block}, first rows · front: Mealybugs 80.0% (house 8.9%)", subject)

    def test_hot_spot_recipients_are_the_alarming_audience(self):
        self.assertEqual(sorted(TC.recipients_for(self.farm, "Rose", B.HOT_SPOT)), sorted([U_CREATOR, U_SUPER]))
        TF.set_roster(self.farm, "creators", [])
        TF.set_roster(self.farm, "supervisors", [])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.HOT_SPOT), [U_GM])   # empty rosters → GMs


class TestSurfaces(HotCase):
    def _house_alarming_and_spot(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0], hot_infested=5, others_infested=2)   # house 46.7 %, corner 100 %
        TC.check_crop("Rose", SUN_20)
        return self.alert().name, self.spot().name

    def test_open_alerts_list_house_before_hot_spot_with_the_section(self):
        house, spot = self._house_alarming_and_spot()
        rows = TC.open_alerts("Rose", greenhouse=self.gh)
        self.assertEqual([(r.name, r.alert_type, r.action) for r in rows],
                         [(house, "House", "Alarming"), (spot, "Hot spot", "Hot spot")])
        self.assertEqual((rows[1].section_label, rows[1].section_row, rows[1].section_col, rows[1].margin),
                         (LABEL, 0, 0, None))
        self.assertEqual((rows[0].section_label or "", rows[0].section_row), ("", -1))

    def test_the_creator_never_sees_a_hot_spot(self):
        _house, spot = self._house_alarming_and_spot()
        self.assertEqual(TC.creator_alerts([self.gh]), {})              # Alarming house + hot spot
        frappe.db.set_value("Scouting Alert", spot, "action", "Spray advised")   # even mislabelled
        self.assertEqual(TC.creator_alerts([self.gh]), {})
        with self.assertRaisesRegex(frappe.ValidationError, "hot spot"):
            TC.assert_alert_for_plan(spot, self.gh)

    def test_the_greenhouse_grid_rings_the_hot_section(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_hot_section(self.gh, TF.WEEK_20[0])
        out = DA.greenhouse_detail(greenhouse=self.gh, from_date=TF.WEEK_20[0], to_date=TF.WEEK_20[1],
                                   crop="Rose", force="1")
        thrips = next(p for p in out["prevalence"] if p["name"] == "Thrips")
        self.assertEqual([(s["row"], s["col"]) for s in thrips["sections"] if s["hot"]], [(0, 0)])
        self.assertEqual(len(thrips["sections"]), 9)
        TF.clear_all_bands("Rose")
        out = DA.greenhouse_detail(greenhouse=self.gh, from_date=TF.WEEK_20[0], to_date=TF.WEEK_20[1],
                                   crop="Rose", force="1")
        thrips = next(p for p in out["prevalence"] if p["name"] == "Thrips")
        self.assertFalse(any(s["hot"] for s in thrips["sections"]))
