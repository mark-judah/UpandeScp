import unittest
from unittest import mock

from upande_scp.upande_scp.doctype.spray_plan_settings import spray_plan_settings as sps


# Warehouse candidate set: (name, custom_farm). Mirrors mona's reality where
# the operational stores/CSUs are untagged (custom_farm=NULL) while greenhouses
# carry the farm. NULL-farm stores are treated as global (visible to every
# allowed-farm user), the same convention the spray-team query uses.
WAREHOUSES = [
    {"name": "Chemical Main Store - MFK", "custom_farm": None},      # NULL → global
    {"name": "Fertilizer Main Store - MFK", "custom_farm": None},    # NULL → global
    {"name": "General Main Store - MFK", "custom_farm": "Main"},
    {"name": "Main CSU - MFK", "custom_farm": None},
    {"name": "Main CSU A - MFK", "custom_farm": "Main"},
    {"name": "Chemical Store - Chepsito", "custom_farm": "Chepsito"},  # other farm → hidden
]


def _patches(farms=("Main",)):
    return (
        mock.patch.object(sps, "get_allowed_farms", return_value=list(farms)),
        mock.patch.object(sps.frappe, "get_all", return_value=[dict(w) for w in WAREHOUSES]),
    )


class TestAllowedStoreWarehouses(unittest.TestCase):
    def test_chemical_store_includes_null_farm(self):
        p1, p2 = _patches()
        with p1, p2:
            self.assertEqual(
                sps.get_allowed_chemical_store_warehouses(),
                ["Chemical Main Store - MFK"],
            )

    def test_other_farm_chemical_store_excluded(self):
        # A chemical store tagged to a farm the user can't see stays hidden,
        # even though NULL-farm stores are global.
        p1, p2 = _patches(farms=("Main",))
        with p1, p2:
            self.assertNotIn(
                "Chemical Store - Chepsito",
                sps.get_allowed_chemical_store_warehouses(),
            )

    def test_fertilizer_store_includes_null_farm(self):
        p1, p2 = _patches()
        with p1, p2:
            self.assertEqual(
                sps.get_allowed_fertilizer_unit_warehouses(),
                ["Fertilizer Main Store - MFK"],
            )

    def test_no_farms_returns_empty(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=[]):
            self.assertEqual(sps.get_allowed_chemical_store_warehouses(), [])
