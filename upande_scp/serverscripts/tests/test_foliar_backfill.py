"""Every configured foliar Item must have a Foliar sidecar.

Before this slice mona had no Foliar master at all, and the spray picker's
hardcoded ["CHEMICALS", "Fertilizer"] filter never matched the real
"Fertilizers" group — so all 26 foliar items were invisible to the spray flow.
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_protection


class TestFoliarBackfill(unittest.TestCase):
    def test_every_fertilizer_item_has_a_foliar_row(self):
        groups = list(crop_protection.product_groups("foliar"))
        self.assertTrue(groups, "foliar item groups are not configured")
        items = frappe.get_all(
            "Item", filters={"item_group": ["in", groups], "disabled": 0}, pluck="name"
        )
        self.assertTrue(items, "no foliar items found on this site")
        missing = [i for i in items if not crop_protection.is_foliar(i)]
        self.assertEqual(missing, [], f"items with no Foliar row: {missing}")

    def test_backfill_is_idempotent(self):
        from upande_scp.patches.v1_0 import backfill_foliar_master

        before = frappe.db.count("Foliar")
        backfill_foliar_master.execute()
        self.assertEqual(frappe.db.count("Foliar"), before)
