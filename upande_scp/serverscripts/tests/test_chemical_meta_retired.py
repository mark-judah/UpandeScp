"""`chemical_meta` is retired in favour of `common.crop_protection`.

The two did the same job a generation apart. crop_protection is the ported,
config-driven version and is the single source of truth for product metadata;
leaving the old module importable invites a caller drifting back onto it.
"""

import pathlib
import re
import unittest

_APP_ROOT = pathlib.Path(__file__).resolve().parents[2]
# `prefill_chemical_metadata` merely contains the substring in its own name.
_USAGE = re.compile(r"(import\s+chemical_meta|chemical_meta\s*\.)")


class TestChemicalMetaRetired(unittest.TestCase):
    def test_module_is_gone(self):
        with self.assertRaises(ImportError):
            from upande_scp.serverscripts import chemical_meta  # noqa: F401

    def test_no_live_usages_remain(self):
        hits = []
        for path in _APP_ROOT.rglob("*.py"):
            if "__pycache__" in str(path) or path.name == pathlib.Path(__file__).name:
                continue
            if _USAGE.search(path.read_text()):
                hits.append(str(path.relative_to(_APP_ROOT)))
        self.assertEqual(hits, [], f"chemical_meta still used in: {hits}")

    def test_replacement_has_the_same_shape(self):
        from upande_scp.serverscripts.common import crop_protection

        self.assertEqual(crop_protection.get_product_rate("__no_such_item__"), (None, None))
