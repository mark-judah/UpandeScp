"""A disabled greenhouse that is still being scouted stays in the farm map.

Regression for Heatmaps showing nothing for Torongo GH 18 in the newest weeks
on kaitet.local: its entries name the disabled "Torongo GH 18 - KR" warehouse,
and ``get_farms_and_warehouses`` (the farm picker and every farm→greenhouse
scope) listed only enabled warehouses — so the only Torongo GH 18 on offer was
"Torongo GH18 - KR", whose data ends in July.

Rows are written with raw SQL and rolled back; nothing is committed.
"""

import unittest

import frappe
from frappe.utils import add_days, nowdate

from upande_scp.serverscripts.scouting import scouting_metrics as SM

FARM = "Torongo"
SCOUTED = "Torongo GH 97 - KR"   # disabled, scouted recently → listed
STALE = "Torongo GH 98 - KR"     # disabled, scouted long ago → not listed
IDLE = "Torongo GH 99 - KR"      # disabled, never scouted → not listed


def _insert_wh(name):
    frappe.db.sql(
        """INSERT INTO `tabWarehouse`
           (name, warehouse_name, warehouse_type, custom_farm, disabled, is_group,
            creation, modified, owner, modified_by, docstatus, idx)
           VALUES (%s, %s, 'Greenhouse', %s, 1, 0, NOW(), NOW(),
                   'Administrator', 'Administrator', 0, 0)""",
        (name, name, FARM),
    )


def _insert_entry(name, greenhouse, date):
    frappe.db.sql(
        """INSERT INTO `tabScouting Entry`
           (name, greenhouse, date_of_capture, crop_scouted,
            creation, modified, owner, modified_by, docstatus, idx)
           VALUES (%s, %s, %s, 'Rose', NOW(), NOW(),
                   'Administrator', 'Administrator', 0, 0)""",
        (name, greenhouse, date),
    )


class TestFarmsDisabledButScouted(unittest.TestCase):
    def setUp(self):
        if not frappe.db.exists("Farm", FARM) and not frappe.db.sql(
            "SELECT 1 FROM `tabWarehouse` WHERE custom_farm = %s LIMIT 1", FARM
        ):
            self.skipTest(f"no {FARM} farm on this site")
        frappe.db.begin()
        for wh in (SCOUTED, STALE, IDLE):
            _insert_wh(wh)
        _insert_entry("TEST-DBS-1", SCOUTED, add_days(nowdate(), -3))
        _insert_entry("TEST-DBS-2", STALE, add_days(nowdate(), -(SM.STILL_SCOUTED_DAYS + 30)))

    def tearDown(self):
        frappe.db.rollback()

    def test_disabled_warehouse_with_recent_scouting_is_listed(self):
        names = {r.name for r in SM._disabled_but_scouted()}
        self.assertIn(SCOUTED, names)
        self.assertNotIn(STALE, names)
        self.assertNotIn(IDLE, names)

    def test_farm_map_carries_it_under_its_farm(self):
        farms = SM.get_farms_and_warehouses()
        torongo = farms.get(FARM) or []
        self.assertIn(SCOUTED, torongo)
        self.assertNotIn(STALE, torongo)
        self.assertNotIn(IDLE, torongo)
        self.assertEqual(torongo, sorted(torongo))
