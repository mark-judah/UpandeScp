"""Item UOM options and stock-UOM conversion.

The Application Plan lets an operator order a chemical in any UOM the ITEM
allows (bottles, grams, ...). The conversion factor must come from ERPNext's own
`UOM Conversion Detail` rows on that Item — a constant in this app would drift
from whatever the user maintains, and a wrong factor silently mis-orders a
chemical by orders of magnitude.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_item_uom_options
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_protection as cp

ITEM = "_TEST-UOM-BOTTLE"
BOTTLE_G = 500.0


class TestItemUomOptions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        for uom in ("Bottle", "Gram"):
            if not frappe.db.exists("UOM", uom):
                frappe.get_doc({"doctype": "UOM", "uom_name": uom}).insert(
                    ignore_permissions=True, ignore_if_duplicate=True
                )
        if frappe.db.exists("Item", ITEM):
            frappe.delete_doc("Item", ITEM, force=True, ignore_permissions=True)
        doc = frappe.get_doc({
            "doctype": "Item", "item_code": ITEM, "item_name": ITEM,
            "item_group": "All Item Groups", "stock_uom": "Bottle",
            "is_stock_item": 0,
        })
        doc.append("uoms", {"uom": "Bottle", "conversion_factor": 1.0})
        doc.append("uoms", {"uom": "Gram", "conversion_factor": 1.0 / BOTTLE_G})
        doc.insert(ignore_permissions=True)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        if frappe.db.exists("Item", ITEM):
            frappe.delete_doc("Item", ITEM, force=True, ignore_permissions=True)
        frappe.db.commit()

    def test_stock_uom_is_always_offered_first_at_factor_one(self):
        opts = cp.item_uom_options(ITEM)
        self.assertEqual(opts[0], {"uom": "Bottle", "conversion_factor": 1.0})

    def test_alternate_uoms_come_from_the_item(self):
        got = {o["uom"]: o["conversion_factor"] for o in cp.item_uom_options(ITEM)}
        self.assertAlmostEqual(got["Gram"], 1.0 / BOTTLE_G)

    def test_an_item_with_no_rows_still_offers_its_stock_uom(self):
        # Most chemicals have no alternate UOMs; the picker must not come up empty.
        code = frappe.db.get_value("Item", {"stock_uom": "Kg", "disabled": 0}, "name")
        if not code:
            self.skipTest("no Kg item on this site")
        opts = cp.item_uom_options(code)
        self.assertTrue(opts)
        self.assertEqual(opts[0]["conversion_factor"], 1.0)

    def test_converts_an_alternate_uom_into_the_stock_uom(self):
        # 1000 g of a 500 g bottle is 2 bottles.
        self.assertAlmostEqual(cp.to_stock_qty(ITEM, 1000, "Gram"), 2.0)

    def test_stock_uom_passes_through_unchanged(self):
        self.assertAlmostEqual(cp.to_stock_qty(ITEM, 7, "Bottle"), 7.0)

    def test_an_unknown_uom_passes_through_rather_than_guessing(self):
        # Scaling by a guess would silently misstate the order; 1:1 at least
        # keeps the number the operator typed.
        self.assertAlmostEqual(cp.to_stock_qty(ITEM, 5, "Furlong"), 5.0)

    def test_missing_uom_or_item_is_a_pass_through(self):
        self.assertAlmostEqual(cp.to_stock_qty(ITEM, 5, None), 5.0)
        self.assertAlmostEqual(cp.to_stock_qty("", 5, "Gram"), 5.0)

    def test_no_options_for_an_unknown_item(self):
        self.assertEqual(cp.item_uom_options("_TEST-DOES-NOT-EXIST"), [])
