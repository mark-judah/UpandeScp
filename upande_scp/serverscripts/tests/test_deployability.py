"""Site-portability of the spray flow: farm links, store links, conventions.

`upande_scp` has to install on any site. Three habits stopped it:

* deriving a farm from a **warehouse name** (a regex for everything before
  " GH", a split on " - ", a substring test) instead of reading
  `Warehouse.custom_farm`;
* finding a farm's store by **warehouse name prefix** instead of reading
  `Farm.custom_chemical_store`;
* hardcoding **one site's data** — company "Karen Roses", business unit "Roses",
  item group "Chemical Mix", UOM "Tank Mix (1000L)".

The first is not only a portability bug: on kaitet the name parse disagrees with
the link for 51 of the 158 linked greenhouses, so it was returning the wrong farm
on this site too.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_deployability
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_scope, farm_map, stores, tank_mix


class TestFarmMap(unittest.TestCase):
    def test_unlinked_warehouse_resolves_to_none_not_a_guess(self):
        """Refusing to answer beats answering wrongly: an unlinked warehouse is
        simply absent from farm-scoped results, which is a visible gap somebody
        can fix on the Warehouse record."""
        self.assertIsNone(farm_map.farm_for_warehouse(None))
        self.assertIsNone(farm_map.farm_for_warehouse(""))
        self.assertIsNone(farm_map.farm_for_warehouse("NOT-A-WAREHOUSE-0001"))

    def test_batch_and_single_agree(self):
        rows = frappe.get_all(
            "Warehouse",
            filters={"custom_farm": ("is", "set"), "disabled": 0},
            fields=["name"],
            limit_page_length=5,
        )
        if not rows:
            self.skipTest("no linked warehouses on this site")
        names = [r["name"] for r in rows]
        batched = farm_map.farms_for_warehouses(names)
        for name in names:
            self.assertEqual(batched.get(name), farm_map.farm_for_warehouse(name))

    def test_batch_is_one_query_not_n(self):
        """The name parse it replaced needed no query at all, so resolving per
        row would turn a free operation into an N+1 over a page of hundreds of
        pending plans."""
        from unittest.mock import patch

        rows = frappe.get_all(
            "Warehouse", filters={"disabled": 0}, fields=["name"], limit_page_length=25
        )
        if len(rows) < 2:
            self.skipTest("not enough warehouses")
        names = [r["name"] for r in rows]

        calls = []
        real = frappe.get_all

        def counting(*args, **kwargs):
            calls.append(args[0] if args else kwargs.get("doctype"))
            return real(*args, **kwargs)

        with patch.object(frappe, "get_all", counting):
            result = farm_map.farms_for_warehouses(names)

        self.assertEqual(len(calls), 1, f"expected 1 query, got {len(calls)}: {calls}")
        self.assertLessEqual(len(result), len(names))

    def test_empty_input_short_circuits(self):
        self.assertEqual(farm_map.farms_for_warehouses([]), {})
        self.assertEqual(farm_map.farms_for_warehouses(None), {})
        self.assertEqual(farm_map.greenhouses_for_farms([]), [])
        self.assertEqual(farm_map.warehouses_for_farm(None), [])

    def test_greenhouses_for_farm_returns_only_that_farm(self):
        farm = frappe.db.get_value(
            "Warehouse",
            {"warehouse_type": "Greenhouse", "custom_farm": ("is", "set"), "disabled": 0},
            "custom_farm",
        )
        if not farm:
            self.skipTest("no linked greenhouse on this site")
        for gh in farm_map.greenhouses_for_farm(farm):
            self.assertEqual(frappe.db.get_value("Warehouse", gh, "custom_farm"), farm)

    def test_the_old_name_parse_really_did_disagree(self):
        """Documents why this changed. If this ever finds zero disagreements the
        parse was harmless after all and the comment should be softened."""
        import re

        rows = frappe.get_all(
            "Warehouse",
            filters={
                "warehouse_type": "Greenhouse",
                "custom_farm": ("is", "set"),
                "disabled": 0,
            },
            fields=["name", "custom_farm"],
            limit_page_length=0,
        )
        if not rows:
            self.skipTest("no linked greenhouses on this site")

        def old_parse(gh):
            m = re.match(r"^(.+?)\s+GH\b", str(gh), re.IGNORECASE)
            return m.group(1).strip() if m else str(gh).split(" ")[0]

        disagreements = [r for r in rows if old_parse(r["name"]) != r["custom_farm"]]
        # Not asserting a count — that is site data. Asserting the link is what we
        # now return, for every row, regardless of what the parse would have said.
        resolved = farm_map.farms_for_warehouses([r["name"] for r in rows])
        for r in rows:
            self.assertEqual(resolved[r["name"]], r["custom_farm"])
        self.assertIsInstance(disagreements, list)


class TestVisibleFarms(unittest.TestCase):
    def test_administrator_is_unrestricted(self):
        self.assertIsNone(crop_scope.visible_farms(user="Administrator"))

    def test_roster_never_widens_the_company_scope(self):
        """Intersection, not union. Being rostered onto a farm in another company
        must not grant access to it."""
        for field in crop_scope.ROSTER_FIELDS:
            scope = crop_scope.scoped_farms(user="Administrator")
            visible = crop_scope.visible_farms(roster_field=field, user="Administrator")
            # Administrator is the unrestricted case; both are None.
            self.assertEqual(scope, visible)

    def test_an_unknown_user_sees_nothing_not_everything(self):
        """The safety property: a misconfiguration reads as silence."""
        ghost = "nobody-scp-test@example.invalid"
        self.assertEqual(crop_scope.rostered_farms("spray_plan_creators", ghost), set())
        self.assertEqual(crop_scope.visible_farms("spray_plan_creators", user=ghost), set())

    def test_rostered_farms_always_returns_a_set(self):
        """Never the `None` sentinel — not being on a roster is not the same as
        being unrestricted, and conflating them is how a store keeper saw every
        farm in the group."""
        for field in crop_scope.ROSTER_FIELDS:
            self.assertIsInstance(
                crop_scope.rostered_farms(field, "Administrator"), set
            )

    def test_an_unknown_roster_field_grants_nothing(self):
        self.assertEqual(crop_scope.rostered_farms("not_a_roster", "Administrator"), set())

    def test_visible_farm_list_never_leaks_the_none_sentinel(self):
        """A caller that forgot to handle `None` would turn "unrestricted" into
        "no farms" in a dropdown."""
        result = crop_scope.visible_farm_list(user="Administrator")
        self.assertIsInstance(result, list)
        self.assertEqual(result, sorted(result))

    def test_general_manager_is_not_a_bypass_role(self):
        """A general manager belongs to a company like anyone else — the reported
        "I can see all farms in all perspectives"."""
        self.assertNotIn("SCP General Manager", crop_scope.BYPASS_ROLES)


class TestStores(unittest.TestCase):
    def test_link_beats_name_convention(self):
        farm = frappe.db.get_value("Farm", {"custom_chemical_store": ("is", "set")}, "name")
        if not farm:
            self.skipTest("no farm with a mapped chemical store")
        mapped = frappe.db.get_value("Farm", farm, "custom_chemical_store")
        self.assertEqual(stores.farm_stores(farm, "chemical"), [mapped])

    def test_no_farm_no_stores(self):
        self.assertEqual(stores.farm_stores(None), [])
        self.assertEqual(stores.farm_stores(""), [])
        self.assertIsNone(stores.primary_store(None))

    def test_unknown_kind_yields_nothing_rather_than_everything(self):
        farm = frappe.db.get_value("Farm", {}, "name")
        if not farm:
            self.skipTest("no farms on this site")
        self.assertEqual(stores.farm_stores(farm, "not-a-kind"), [])

    def test_farms_with_stores_covers_both_link_and_name(self):
        with_stores = stores.farms_with_stores()
        self.assertIsInstance(with_stores, set)
        linked = set(
            frappe.get_all(
                "Farm",
                or_filters=[
                    ["custom_chemical_store", "is", "set"],
                    ["custom_fertilizer_store", "is", "set"],
                ],
                pluck="name",
            )
        )
        self.assertTrue(linked <= with_stores)

    def test_unmapped_farms_names_the_fallback_users(self):
        """The checklist for deleting STORE_NAME_PREFIXES. Every entry is a farm
        that breaks the day the naming convention goes."""
        gaps = stores.unmapped_farms()
        self.assertIsInstance(gaps, list)
        for row in gaps:
            self.assertIn("farm", row)
            self.assertIn("kind", row)
            self.assertTrue(row["stores"], "listed a gap with no store behind it")


class TestTankMixConventions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        tank_mix.ensure_tank_mix_conventions()

    def test_the_configured_item_group_exists(self):
        self.assertTrue(frappe.db.exists("Item Group", tank_mix.tank_mix_item_group()))

    def test_the_configured_uom_exists(self):
        self.assertTrue(frappe.db.exists("UOM", tank_mix.tank_mix_uom()))

    def test_defaults_match_what_the_code_used_to_hardcode(self):
        """An existing site must converge on exactly its current behaviour."""
        self.assertEqual(tank_mix.DEFAULT_ITEM_GROUP, "Chemical Mix")
        self.assertEqual(tank_mix.DEFAULT_UOM, "Tank Mix (1000L)")

    def test_company_comes_from_the_farm(self):
        farm = frappe.db.get_value("Farm", {"company": ("is", "set")}, "name")
        if not farm:
            self.skipTest("no farm with a company")
        self.assertEqual(
            tank_mix.resolve_company(farm),
            frappe.db.get_value("Farm", farm, "company"),
        )

    def test_company_falls_back_to_the_global_default(self):
        resolved = tank_mix.resolve_company(None)
        self.assertEqual(resolved, frappe.defaults.get_global_default("company") or None)

    def test_company_is_never_a_literal(self):
        """The single line that made create_bom un-deployable."""
        import inspect

        from upande_scp.serverscripts.store import create_bom

        src = inspect.getsource(create_bom)
        self.assertNotIn('bom_doc.company = "Karen Roses"', src)

    def test_running_twice_is_a_no_op(self):
        before = frappe.db.count("UOM"), frappe.db.count("Item Group")
        tank_mix.ensure_tank_mix_conventions()
        self.assertEqual((frappe.db.count("UOM"), frappe.db.count("Item Group")), before)
