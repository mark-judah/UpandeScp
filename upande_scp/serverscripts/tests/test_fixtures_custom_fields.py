import unittest

from upande_scp import hooks


REQUIRED = [
    "Warehouse-custom_farm",
    "BOM-custom_farm",
    "Cost Center-custom_farm",
    "Work Order-custom_chemical_scans",
    "Work Order-custom_spray_application_logsheet",
]


def _custom_field_names():
    for f in hooks.fixtures:
        if isinstance(f, dict) and f.get("doctype") == "Custom Field":
            # filters == [["name", "in", [ ...names... ]]]
            return f["filters"][0][2]
    raise AssertionError("no Custom Field fixture found")


class TestRequiredCustomFieldFixtures(unittest.TestCase):
    def test_required_fields_present(self):
        names = _custom_field_names()
        for n in REQUIRED:
            self.assertIn(n, names)
