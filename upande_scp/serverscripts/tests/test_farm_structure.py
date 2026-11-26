"""Farm structure endpoint: type paths and the live node tree.

Run: bench --site kaitet.local run-tests \
        --module upande_scp.serverscripts.tests.test_farm_structure
"""

import time
import unittest

import frappe

from upande_scp.serverscripts.geo.farm_structure import get_farm_structure

FARM = "_Test SCP Structure"
LEVELS = (
    "Has Greenhouses", "Has Blocks", "Has Beds", "Has Rows",
    "Has Zones", "Has Orchard Trees", "Has Triads",
)
PFX = "_Test SCP Struct"


def _ensure_farm():
    for level in LEVELS:
        if not frappe.db.exists("Farm Type", level):
            frappe.get_doc({"doctype": "Farm Type", "farm_type": level}).insert(ignore_permissions=True)
    if frappe.db.exists("Farm", FARM):
        farm = frappe.get_doc("Farm", FARM)
        farm.set("farm_type", [{"farm_type": l} for l in LEVELS])
        farm.flags.ignore_mandatory = True
        farm.save(ignore_permissions=True)
        return FARM
    doc = frappe.get_doc(
        {"doctype": "Farm", "farm_name": FARM, "farm_type": [{"farm_type": l} for l in LEVELS]}
    )
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    return doc.name


def _wh_type(name):
    if not frappe.db.exists("Warehouse Type", name):
        frappe.get_doc({"doctype": "Warehouse Type", "name": name}).insert(ignore_permissions=True)


def _wh(label, wtype, parent=None, group=0):
    existing = frappe.db.exists("Warehouse", {"warehouse_name": label})
    values = {
        "custom_farm": FARM,
        "warehouse_type": wtype,
        "parent_warehouse": parent,
        "is_group": group,
    }
    if existing:
        frappe.db.set_value("Warehouse", existing, values, update_modified=False)
        frappe.clear_document_cache("Warehouse", existing)
        return existing
    doc = frappe.get_doc(
        {
            "doctype": "Warehouse",
            "warehouse_name": label,
            "company": frappe.db.get_value("Company", {}, "name"),
            **values,
        }
    )
    doc.insert(ignore_permissions=True)
    return doc.name


def _bed(wh, kind, n):
    return frappe.get_doc(
        {"doctype": "Bed", "greenhouse": wh, "unit_type": kind, "bed": n, "farm": FARM}
    ).insert(ignore_permissions=True).name


class FarmStructureCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._clean()
        _ensure_farm()
        for t in ("Phase", "Section", "Pivot", "Block", "Farm"):
            _wh_type(t)
        farm_wh = _wh(f"{PFX} Farm", "Farm", group=1)
        phase = _wh(f"{PFX} Phase", "Phase", farm_wh, 1)
        section = _wh(f"{PFX} Section", "Section", phase, 1)
        cls.hexa_block = _wh(f"{PFX} Hexa Block", "Block", section)
        pivot = _wh(f"{PFX} Pivot", "Pivot", farm_wh, 1)
        cls.row_block = _wh(f"{PFX} Row Block", "Block", pivot)
        cls.blank = _wh(f"{PFX} Blank", None, farm_wh)
        cls.empty_gh = _wh(f"{PFX} Empty GH", "Greenhouse", farm_wh)

        hexa = _bed(cls.hexa_block, "Hexa", 1)
        for t in range(1, 5):
            frappe.get_doc(
                {"doctype": "Triad", "row": hexa, "triad": t, "block": cls.hexa_block, "farm": FARM}
            ).insert(ignore_permissions=True)
        row = _bed(cls.row_block, "Row", 1)
        for t in range(1, 3):
            frappe.get_doc(
                {"doctype": "Orchard Tree", "row": row, "tree": t, "block": cls.row_block, "farm": FARM}
            ).insert(ignore_permissions=True)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        cls._clean()

    @classmethod
    def _clean(cls):
        stations = frappe.get_all("Warehouse", filters={"custom_farm": FARM}, pluck="name")
        for bed in frappe.get_all("Bed", filters={"greenhouse": ["in", stations or [""]]}, pluck="name"):
            for dt in ("Zone", "Orchard Tree", "Triad"):
                for c in frappe.get_all(dt, filters={"row" if dt != "Zone" else "bed": bed}, pluck="name"):
                    frappe.delete_doc(dt, c, force=True, ignore_permissions=True)
            frappe.delete_doc("Bed", bed, force=True, ignore_permissions=True)
        frappe.db.commit()
        frappe.cache.delete_value(f"scp:farm_structure:{FARM}")

    def get(self, **kw):
        return get_farm_structure(FARM, refresh=1, **kw)

    def find(self, node, name):
        if node["name"] == name:
            return node
        for c in node["children"]:
            hit = self.find(c, name)
            if hit:
                return hit

    def test_two_branches_give_two_paths(self):
        types = [p["types"] for p in self.get()["paths"]]
        self.assertIn(["Farm", "Phase", "Section", "Block", "Hexa", "Triad"], types)
        self.assertIn(["Farm", "Pivot", "Block", "Row", "Tree"], types)

    def test_hexa_block_counts_and_edge(self):
        node = self.find(self.get()["root"], self.hexa_block)
        self.assertEqual(node["unit"], {"kind": "Hexa", "units": 1, "children": 4, "edge": 1})

    def test_payload_carries_the_standard_triangle_side(self):
        self.assertGreater(self.get()["triad_side_m"], 0)

    def test_blank_type_is_flagged(self):
        node = self.find(self.get()["root"], self.blank)
        self.assertEqual(node["type"], "(no type)")
        self.assertIn("no type", node["flags"])

    def test_station_without_units_flagged_no_layout(self):
        node = self.find(self.get()["root"], self.empty_gh)
        self.assertIsNone(node["unit"])
        self.assertIn("no layout", node["flags"])

    def test_unknown_farm_returns_empty_root(self):
        r = get_farm_structure("_No Such Farm", refresh=1)
        self.assertIsNone(r["root"])
        self.assertEqual(r["paths"], [])

    def test_cached_until_refresh(self):
        first = self.get()
        self.assertEqual(get_farm_structure(FARM)["built_at"], first["built_at"])
        time.sleep(1.1)
        self.assertNotEqual(get_farm_structure(FARM, refresh=1)["built_at"], first["built_at"])


class TestFarmStructureEdges(FarmStructureCase):
    def test_guest_is_refused(self):
        frappe.set_user("Guest")
        try:
            with self.assertRaises(frappe.PermissionError):
                get_farm_structure(FARM, refresh=1)
        finally:
            frappe.set_user("Administrator")

    def test_unknown_unit_kind_does_not_crash(self):
        station = _wh(f"{PFX} Odd Block", "Block", frappe.db.get_value("Warehouse", self.hexa_block, "parent_warehouse"))
        bed = frappe.get_doc(
            {"doctype": "Bed", "greenhouse": station, "unit_type": "Band", "bed": 1, "farm": FARM}
        )
        bed.db_insert()
        try:
            res = self.get()
            node = self.find(res["root"], station)
            self.assertEqual(node["unit"]["kind"], "Band")
            self.assertIn("unknown kind", node["flags"])
            self.assertTrue(any(p["types"][-2:] == ["Band", "?"] for p in res["paths"]))
        finally:
            frappe.db.delete("Bed", {"name": bed.name})


    CROP = "_Test Struct Crop"

    def _crop(self):
        if not frappe.db.exists("Crop Scouted", self.CROP):
            frappe.get_doc({"doctype": "Crop Scouted", "crop_name": self.CROP}).insert(ignore_permissions=True)
        return self.CROP

    def tearDown(self):
        frappe.set_user("Administrator")
        frappe.db.set_value("Warehouse", {"custom_farm": FARM}, "custom_crop", None)
        frappe.cache.delete_value(f"scp:farm_structure:{FARM}")

    def test_set_inherit_and_clear(self):
        from upande_scp.serverscripts.geo.farm_structure import set_node_crop

        pivot = frappe.db.get_value("Warehouse", {"warehouse_name": f"{PFX} Pivot"})
        out = set_node_crop(pivot, self._crop())
        self.assertEqual(out["crop"], self._crop())
        root = self.get()["root"]
        self.assertEqual(self.find(root, pivot)["crop"]["own"], self._crop())
        kid = self.find(root, self.row_block)["crop"]
        self.assertIsNone(kid["own"])
        self.assertEqual((kid["inherited"], kid["inherited_from"]), (self._crop(), f"{PFX} Pivot"))
        self.assertIn(self._crop(), self.get()["crops"])
        set_node_crop(pivot, "")
        self.assertIsNone(frappe.db.get_value("Warehouse", pivot, "custom_crop"))
        self.assertIsNone(self.find(self.get()["root"], self.row_block)["crop"]["inherited"])

    def test_unknown_crop_and_node_refused(self):
        from upande_scp.serverscripts.geo.farm_structure import set_node_crop

        with self.assertRaises(frappe.ValidationError):
            set_node_crop(self.row_block, "No Such Crop")
        with self.assertRaises(frappe.DoesNotExistError):
            set_node_crop("No Such Warehouse", self._crop())
        self.assertFalse(frappe.db.get_value("Warehouse", self.row_block, "custom_crop"))

    def test_write_permission_required(self):
        from upande_scp.serverscripts.geo.farm_structure import set_node_crop

        email = "struct-nowrite@example.com"
        if not frappe.db.exists("User", email):
            frappe.get_doc(
                {"doctype": "User", "email": email, "first_name": "NoWrite", "send_welcome_email": 0}
            ).insert(ignore_permissions=True)
        frappe.set_user(email)
        with self.assertRaises(frappe.PermissionError):
            set_node_crop(self.row_block, self._crop())
        frappe.set_user("Administrator")
        self.assertFalse(frappe.db.get_value("Warehouse", self.row_block, "custom_crop"))

    def test_catalog_cache_invalidated(self):
        from unittest import mock

        from upande_scp.serverscripts.geo.farm_structure import set_node_crop

        with mock.patch("upande_scp.serverscripts.common.crop_catalog.invalidate_catalog") as inv:
            set_node_crop(self.row_block, self._crop())
            inv.assert_called_once()
            inv.reset_mock()
            with self.assertRaises(frappe.ValidationError):
                set_node_crop(self.row_block, "No Such Crop")
            inv.assert_not_called()
        set_node_crop(self.row_block, "")
