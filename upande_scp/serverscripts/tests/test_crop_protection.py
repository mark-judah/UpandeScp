"""Config-driven crop-protection classification on mona.

A focused subset of kaitet's suite. Kaitet's full end-to-end file exercises the
settings editor, the packaged `serverscripts/{store,scouting}` modules and the
group-overlap validator, and asserts that Item's chemical `custom_*` fields have
been dropped — none of which is true on mona, whose `backfill_chemical_master`
patch still reads those fields. Those tests belong with the slices that port
those features.

What is tested here is what this slice installs: classification driven by the
`Spray Plan Settings` item-group config, and the sidecar auto-create hook.

Run: bench --site mona.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_crop_protection
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_protection as cp

SETTINGS = "Spray Plan Settings"
CHEM_GROUP = "_TEST CP Chemicals"
FOL_GROUP = "_TEST CP Foliars"
_ITEM_PREFIX = "_TEST-CP-"


def _ensure_item_group(name):
    if not frappe.db.exists("Item Group", name):
        frappe.get_doc({
            "doctype": "Item Group",
            "item_group_name": name,
            "parent_item_group": "All Item Groups",
            "is_group": 0,
        }).insert(ignore_permissions=True, ignore_if_duplicate=True)


def _delete_sidecars_for(code):
    for master in ("Chemical", "Foliar"):
        name = frappe.db.get_value(master, {"item": code}, "name")
        if name:
            frappe.delete_doc(master, name, force=True, ignore_permissions=True)


def _make_item(code, group):
    _delete_sidecars_for(code)
    if frappe.db.exists("Item", code):
        frappe.delete_doc("Item", code, force=True, ignore_permissions=True)
    return frappe.get_doc({
        "doctype": "Item",
        "item_code": code,
        "item_name": code,
        "item_group": group,
        "stock_uom": "Nos",
        "is_stock_item": 0,
    }).insert(ignore_permissions=True)


class TestCropProtection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        _ensure_item_group(CHEM_GROUP)
        _ensure_item_group(FOL_GROUP)
        settings = frappe.get_single(SETTINGS)
        chem = {r.item_group for r in (settings.get("chemical_item_groups") or [])}
        fol = {r.item_group for r in (settings.get("foliar_item_groups") or [])}
        if CHEM_GROUP not in chem:
            settings.append("chemical_item_groups", {"item_group": CHEM_GROUP})
        if FOL_GROUP not in fol:
            settings.append("foliar_item_groups", {"item_group": FOL_GROUP})
        settings.save(ignore_permissions=True)
        frappe.db.commit()
        frappe.clear_cache()

    @classmethod
    def tearDownClass(cls):
        for master in ("Chemical", "Foliar"):
            for name in frappe.get_all(master, filters={"item": ["like", f"{_ITEM_PREFIX}%"]}, pluck="name"):
                frappe.delete_doc(master, name, force=True, ignore_permissions=True)
        for name in frappe.get_all("Item", filters={"item_code": ["like", f"{_ITEM_PREFIX}%"]}, pluck="name"):
            frappe.delete_doc("Item", name, force=True, ignore_permissions=True)
        settings = frappe.get_single(SETTINGS)
        settings.chemical_item_groups = [
            r for r in (settings.get("chemical_item_groups") or []) if r.item_group != CHEM_GROUP
        ]
        settings.foliar_item_groups = [
            r for r in (settings.get("foliar_item_groups") or []) if r.item_group != FOL_GROUP
        ]
        settings.save(ignore_permissions=True)
        for name in (CHEM_GROUP, FOL_GROUP):
            if frappe.db.exists("Item Group", name):
                frappe.delete_doc("Item Group", name, force=True, ignore_permissions=True)
        frappe.db.commit()
        frappe.clear_cache()

    # -- classification against a throwaway config ----------------------
    def test_classify_item_group(self):
        self.assertEqual(cp.classify_item_group(CHEM_GROUP), "chemical")
        self.assertEqual(cp.classify_item_group(FOL_GROUP), "foliar")
        self.assertIsNone(cp.classify_item_group("All Item Groups"))
        self.assertIsNone(cp.classify_item_group(None))

    def test_is_foliar_group(self):
        self.assertTrue(cp.is_foliar_group(FOL_GROUP))
        self.assertFalse(cp.is_foliar_group(CHEM_GROUP))

    def test_product_groups_filters_by_kind(self):
        self.assertIn(CHEM_GROUP, cp.product_groups("chemical"))
        self.assertNotIn(FOL_GROUP, cp.product_groups("chemical"))
        self.assertIn(FOL_GROUP, cp.product_groups("foliar"))
        both = cp.product_groups()
        self.assertIn(CHEM_GROUP, both)
        self.assertIn(FOL_GROUP, both)

    # -- auto-create hook ----------------------------------------------
    def test_item_insert_autocreates_chemical(self):
        item = _make_item(f"{_ITEM_PREFIX}CHEM-1", CHEM_GROUP)
        self.assertTrue(cp.is_chemical(item.name))
        self.assertFalse(cp.is_foliar(item.name))

    def test_item_insert_autocreates_foliar(self):
        item = _make_item(f"{_ITEM_PREFIX}FOL-1", FOL_GROUP)
        self.assertTrue(cp.is_foliar(item.name))
        self.assertFalse(cp.is_chemical(item.name))

    # -- mona's real configuration --------------------------------------
    def test_mona_item_groups_are_configured(self):
        """The defect this slice fixes: the picker hardcoded "CHEMICALS" and
        "Fertilizer"; mona's real groups are "Chemicals" and "Fertilizers", so
        every foliar item was invisible."""
        self.assertIn("Chemicals", cp.chemical_groups())
        self.assertIn("Fertilizers", cp.foliar_groups())
        self.assertEqual(cp.classify_item_group("Chemicals"), "chemical")
        self.assertEqual(cp.classify_item_group("Fertilizers"), "foliar")
        self.assertIsNone(cp.classify_item_group("Chemical Mix"))
