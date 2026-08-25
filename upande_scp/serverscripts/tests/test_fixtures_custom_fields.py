"""Guard that the custom fields the app depends on actually ship with it.

These fields used to be a `Custom Field` entry in `hooks.fixtures`. They are
deliberately not any more: fixture import aborts the whole migrate on the first
already-existing field/column, which kept breaking deploys. They now live in
`fixtures/custom_field.json` and are applied idempotently by the
`ensure_scp_custom_fields` patch, which skips existing fields and isolates
failures.

The guard is the same — these fields must ship — but it has to read the file
that is now the source of truth, not the hooks list.
"""

import json
import pathlib
import unittest

REQUIRED = [
    "Warehouse-custom_farm",
    "BOM-custom_farm",
    "Cost Center-custom_farm",
    "Work Order-custom_chemical_scans",
    "Work Order-custom_spray_application_logsheet",
]

_APP_ROOT = pathlib.Path(__file__).resolve().parents[2]
_FIXTURE = _APP_ROOT / "fixtures" / "custom_field.json"


def _custom_field_names():
    if not _FIXTURE.exists():
        raise AssertionError(f"custom field fixture not found at {_FIXTURE}")
    rows = json.loads(_FIXTURE.read_text())
    return {f"{r.get('dt')}-{r.get('fieldname')}" for r in rows}


class TestRequiredCustomFieldFixtures(unittest.TestCase):
    def test_required_fields_present(self):
        names = _custom_field_names()
        for n in REQUIRED:
            self.assertIn(n, names, f"{n} is missing from {_FIXTURE.name}")

    def test_fields_are_not_shipped_as_a_hooks_fixture(self):
        """Re-adding them to hooks.fixtures would resurrect the deploy break."""
        from upande_scp import hooks

        offenders = [
            f for f in hooks.fixtures
            if isinstance(f, dict) and f.get("doctype") == "Custom Field"
        ]
        self.assertEqual(
            offenders, [],
            "Custom Field is back in hooks.fixtures — fixture import aborts "
            "migrate on the first existing field; use the patch instead",
        )

    def test_the_patch_reads_the_fixture(self):
        """The guard only means something while the patch still applies it."""
        import inspect

        from upande_scp.patches.v1_0 import ensure_scp_custom_fields

        self.assertIn("custom_field.json", inspect.getsource(ensure_scp_custom_fields))
