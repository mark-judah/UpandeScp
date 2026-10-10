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
