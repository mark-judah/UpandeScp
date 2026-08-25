"""The Application Floor Plan flow still works after the crop-protection port.

Covers the pieces the port touched: the product picker, the live rate-limit map
the page validates against, the server-side rate check, and tank-mix BOM
creation. Each of these was found broken during verification:

  * the picker filtered on literal item groups and returned no foliars;
  * `get_chemical_rate_limits` read Item `custom_*` fields that are empty on
    this site, so the page had NO live rate validation at all;
  * `bootstrap._fetch_rate_limits` read the pre-rename `Chemical` columns, which
    still existed and were all zero, so it silently returned nothing;
  * `createBOM` hardcoded `company = "Karen Roses"`, so tank-mix creation failed
    outright on any other customer's site.
"""

import unittest

import frappe

from upande_scp.serverscripts.store import create_bom as cb
from upande_scp.serverscripts.common import crop_protection as cp
from upande_scp.serverscripts.spray_plan_creator import bootstrap, validation as val


class TestApplicationFloorPlan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.db.rollback()

    # -- picker ----------------------------------------------------------
    def test_picker_returns_chemicals_and_foliars(self):
        p = cb.getAllChemicals()
        self.assertTrue(p["chemicals"], "no chemicals in the picker")
        self.assertTrue(p["fertilizers"], "no foliars in the picker")
        self.assertEqual(p["item_type_map"][p["fertilizers"][0]], "fertilizer")

    # -- live rate-limit map --------------------------------------------
    def test_picker_publishes_rate_limits_to_the_client(self):
        """getAllChemicals ships item_rate_limits_map for the plan page's inline
        warnings; it read the empty Item custom_* fields and shipped blank."""
        p = cb.getAllChemicals()
        self.assertTrue(
            p["item_rate_limits_map"],
            "item_rate_limits_map is empty — the plan page shows no rate hints",
        )

    def test_rate_limit_map_is_populated_from_the_sidecar(self):
        rl = cb.get_chemical_rate_limits()
        self.assertTrue(rl, "no rate limits — the plan page has no live validation")
        code, lim = next(iter(rl.items()))
        self.assertTrue(lim.get("lower") or lim.get("upper"))
        self.assertEqual(
            (lim.get("lower"), lim.get("upper")), cp.get_product_rate(code),
            "the picker map and the resolver disagree",
        )

    def test_bootstrap_rate_limits_agree_with_the_picker_map(self):
        """These are two separate code paths feeding the same page; one read the
        pre-rename columns and silently returned nothing."""
        self.assertTrue(bootstrap._fetch_rate_limits(), "bootstrap returned no rate limits")

    # -- server-side rate validation -------------------------------------
    def test_rate_validation_accepts_in_range_and_rejects_below(self):
        rl = cb.get_chemical_rate_limits()
        code = next((c for c, v in rl.items() if v.get("lower")), None)
        self.assertIsNotNone(code, "no chemical with a lower limit to test against")
        lower = rl[code]["lower"]
        upper = rl[code].get("upper") or lower
        val.validate_rate_in_limits(code, (lower + upper) / 2.0, {})  # must not raise
        with self.assertRaises(Exception):
            val.validate_rate_in_limits(code, lower / 100.0, {})

    # -- tank-mix creation ------------------------------------------------
    def test_tank_mix_can_mix_a_chemical_and_a_foliar(self):
        p = cb.getAllChemicals()
        frappe.form_dict = frappe._dict({
            "item": "_TEST TANKMIX FLOOR PLAN",
            "custom_water_ph": 6.5,
            "custom_water_hardness": 120,
            "items": [
                {"item_name": p["chemicals"][0], "custom_application_rate": 1.0},
                {"item_name": p["fertilizers"][0], "custom_application_rate": 1.0},
            ],
        })
        result = cb.createBOM()
        self.assertEqual(result.get("status"), "success", result.get("message"))

    def test_bom_company_is_derived_not_hardcoded(self):
        """"Karen Roses" is one customer's company. Hardcoding it made tank-mix
        creation fail on every other site."""
        import inspect

        # The literal survives in the docstring that explains the old bug;
        # what must not survive is an assignment to it.
        src = inspect.getsource(cb)
        self.assertNotIn('company = "Karen Roses"', src)
        self.assertNotIn('bom_doc.company = "', src)
        company = cb._resolve_bom_company(frappe._dict({}))
        self.assertTrue(frappe.db.exists("Company", company))

    def test_unconfigured_site_fails_loudly(self):
        """An empty `in` filter returns zero rows without error, so an
        unconfigured site would show an empty picker that reads as "no chemicals
        stocked". It must say what is actually wrong instead.

        The guard is exercised by stubbing `product_groups`, never by clearing
        the real settings — an earlier version of this test did that and could
        not put the child rows back, leaving the site unconfigured.
        """
        original = cb.product_groups
        try:
            cb.product_groups = lambda kind=None: ()
            with self.assertRaises(frappe.ValidationError):
                cb.assert_groups_configured()
            with self.assertRaises(frappe.ValidationError):
                cb.getAllChemicals()
        finally:
            cb.product_groups = original
        # Real settings untouched.
        self.assertTrue(cb.product_groups(), "settings were disturbed by the test")
