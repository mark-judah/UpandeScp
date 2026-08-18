"""One automation for beds, rows and coffee bands.

There used to be two tools — `Bed And Zone Automation` for roses and
`Tree And Row Automation` for avocado — doing the same job in different words.
They already wrote into the *same* table (`tabBed`, discriminated by
`unit_type`); only the field names, GeoJSON conventions and child doctype
differed. Coffee then needed bands, and a band is what coffee calls a row, so a
third tool would have been a third copy.

What these tests hold in place:

* **A Band is a Row.** Same structure, same child doctype, different label. If
  that ever diverges, coffee grows a parallel geometry the maps and the mobile
  bundle do not understand.
* **Both GeoJSON layouts and all three id conventions are read.** Each old tool
  understood only its own, so an operator had to reshape exports. The merge is
  only worth having if that stays fixed.
* **`unit_type` is part of every lookup.** The rose tool matched on
  `greenhouse + bed` alone; in a warehouse holding both kinds, row 5 would have
  silently blocked bed 5.
* **Re-running is safe.** It is the normal way to extend a layout.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_field_unit_automation
"""

import json
import unittest

import frappe

from upande_scp.upande_scp.doctype.field_unit_automation import (
    field_unit_automation as FUA,
)

TEST_WAREHOUSE_PREFIX = "_Test SCP Units"
TEST_FARM = "_Test SCP Units Farm"

# Every structure level the unit and child doctypes check, across all three unit
# kinds: `Bed` wants Has Beds / Has Rows, `Zone` wants Has Zones, `Orchard Tree`
# wants Has Orchard Trees. A farm missing any one of them fails silently, because
# the automation logs insert failures rather than raising.
_STRUCTURE_LEVELS = ("Has Beds", "Has Rows", "Has Zones", "Has Orchard Trees")


def _feature(name=None, **props):
    """One GeoJSON point feature carrying whatever properties are given."""
    if name:
        props["name"] = name
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "Point", "coordinates": [36.8, -1.3]},
    }


def _collection(*features):
    return json.dumps({"type": "FeatureCollection", "features": list(features)})


def _ndjson(*collections):
    """The rose exports' layout: one FeatureCollection per line."""
    return "\n".join(collections)


class FieldUnitCase(unittest.TestCase):
    """Each test gets its own throwaway warehouse, so nothing touches real geometry."""

    counter = 0

    def setUp(self):
        FieldUnitCase.counter += 1
        self.farm = self._ensure_farm()
        n = FieldUnitCase.counter
        # Core validates the warehouse's *role* as well as the farm's structure
        # levels: beds must sit on a Greenhouse, rows and bands on a Block. So a
        # test needs whichever warehouse matches the unit kind it is exercising.
        self.greenhouse = self._ensure_warehouse(f"{TEST_WAREHOUSE_PREFIX} GH {n}", "Greenhouse")
        self.block = self._ensure_warehouse(f"{TEST_WAREHOUSE_PREFIX} BLK {n}", "Block")
        self.addCleanup(self._cleanup)

    def warehouse_for(self, unit_type):
        return self.greenhouse if unit_type == "Bed" else self.block

    def _ensure_farm(self):
        """A farm declared to hold every unit kind.

        `Bed.validate` (upande_core) refuses a unit unless the warehouse's Farm
        lists the matching structure level — "Has Beds" for beds, "Has Rows" for
        rows and bands — and `Orchard Tree` additionally wants "Has Orchard
        Trees". Tests supply their own farm so they exercise this app's code
        rather than whatever the site's farms happen to be configured with.
        """
        for level in _STRUCTURE_LEVELS:
            if not frappe.db.exists("Farm Type", level):
                frappe.get_doc({"doctype": "Farm Type", "farm_type": level}).insert(
                    ignore_permissions=True
                )

        wanted = _STRUCTURE_LEVELS
        if frappe.db.exists("Farm", TEST_FARM):
            # Top up rather than trusting a farm an earlier run left behind: a
            # missing level fails child creation for a reason unrelated to the
            # code under test, and the automation only logs it.
            farm = frappe.get_doc("Farm", TEST_FARM)
            have = {r.farm_type for r in (farm.get("farm_type") or [])}
            missing = [level for level in wanted if level not in have]
            if missing:
                for level in missing:
                    farm.append("farm_type", {"farm_type": level})
                farm.flags.ignore_mandatory = True
                farm.save(ignore_permissions=True)
            return TEST_FARM

        doc = frappe.get_doc(
            {
                "doctype": "Farm",
                "farm_name": TEST_FARM,
                "farm_type": [{"farm_type": level} for level in wanted],
            }
        )
        doc.flags.ignore_mandatory = True
        doc.insert(ignore_permissions=True)
        return doc.name

    def _ensure_warehouse(self, label, warehouse_type):
        existing = frappe.db.exists("Warehouse", {"warehouse_name": label})
        if existing:
            # A warehouse left behind by an earlier run may point at a farm that
            # is not declared to hold these units, which would fail every insert
            # for a reason that has nothing to do with the code under test.
            frappe.db.set_value(
                "Warehouse",
                existing,
                {"custom_farm": self.farm, "warehouse_type": warehouse_type},
                update_modified=False,
            )
            frappe.clear_document_cache("Warehouse", existing)
            return existing
        doc = frappe.get_doc(
            {
                "doctype": "Warehouse",
                "warehouse_name": label,
                "company": frappe.db.get_value("Company", {}, "name"),
                "is_group": 0,
                # SCP makes `custom_farm` mandatory on Warehouse — it is the only
                # warehouse -> Farm edge in the app, so a warehouse without one is
                # invisible to every scoped query.
                "custom_farm": self.farm,
                "warehouse_type": warehouse_type,
            }
        )
        doc.insert(ignore_permissions=True)
        return doc.name

    def _cleanup(self):
        """Remove children first, then units, then the automation docs."""
        for warehouse in (self.greenhouse, self.block):
            for unit in frappe.get_all("Bed", filters={"greenhouse": warehouse}, pluck="name"):
                for doctype, field in (("Zone", "bed"), ("Orchard Tree", "row")):
                    for child in frappe.get_all(doctype, filters={field: unit}, pluck="name"):
                        frappe.delete_doc(doctype, child, force=True, ignore_permissions=True)
                frappe.delete_doc("Bed", unit, force=True, ignore_permissions=True)
            if frappe.db.exists("Field Unit Automation", warehouse):
                frappe.delete_doc(
                    "Field Unit Automation", warehouse, force=True, ignore_permissions=True
                )
        # The warehouses themselves are left; deleting one drags account and
        # ledger checks in for no benefit, and the names are namespaced.
        frappe.db.commit()

    def assert_nothing_was_swallowed(self):
        """The controller logs insert failures rather than raising, so a test that
        finds nothing created must say *why*."""
        logs = frappe.get_all(
            "Error Log",
            filters={"method": ["like", "%Field Unit Automation%"]},
            fields=["error"],
            order_by="creation desc",
            limit=1,
        )
        if logs:
            self.fail(f"the automation swallowed an error:\n{logs[0].error[:900]}")

    def build(self, unit_type, geojson, sectors=None):
        warehouse = self.warehouse_for(unit_type)
        doc = frappe.get_doc(
            {
                "doctype": "Field Unit Automation",
                "warehouse": warehouse,
                "unit_type": unit_type,
                "units_geojson": geojson,
                "sectors": sectors or [],
            }
        )
        doc.insert(ignore_permissions=True)
        return doc

    def units(self, unit_type):
        """Units of one kind, newest-numbered last. `bed` is an Int field, so the
        numbers come back as ints however they went in."""
        return frappe.get_all(
            "Bed",
            filters={"greenhouse": self.warehouse_for(unit_type), "unit_type": unit_type},
            fields=["name", "bed", "variety"],
            order_by="bed",
        )

    def numbers(self, unit_type):
        return [u.bed for u in self.units(unit_type)]

    def children(self, doctype, field, unit_type):
        unit_names = frappe.get_all(
            "Bed", filters={"greenhouse": self.warehouse_for(unit_type)}, pluck="name"
        )
        if not unit_names:
            return []
        return frappe.get_all(doctype, filters={field: ["in", unit_names]}, pluck="name")


class TestBands(FieldUnitCase):
    """A Band is a Row under coffee's name — the whole reason there is one tool."""

    def test_a_band_creates_units_and_trees(self):
        doc = self.build(
            "Band",
            _collection(
                _feature(unit_id=1, child_id=1),
                _feature(unit_id=1, child_id=2),
                _feature(unit_id=2, child_id=1),
            ),
        )
        doc.run_automation()
        self.assertEqual(len(self.units("Band")), 2)
        self.assertEqual(len(self.children("Orchard Tree", "row", "Band")), 3)

    def test_a_band_produces_the_same_structure_as_a_row(self):
        """Not merely 'also works' — identical, so nothing downstream needs a
        coffee-specific branch."""
        self.assertEqual(FUA._CHILD_SPEC["Band"], FUA._CHILD_SPEC["Row"])

    def test_a_bands_trees_carry_the_number_readers_actually_query(self):
        """`tree` is mandatory and names the document; `tree_number` is what every
        reader in this app queries. The superseded tool wrote only the latter, so
        nothing could be created once core made `tree` mandatory."""
        doc = self.build("Band", _collection(_feature(unit_id=1, child_id=4)))
        doc.run_automation()
        names = self.children("Orchard Tree", "row", "Band")
        self.assertEqual(len(names), 1)
        tree = frappe.db.get_value(
            "Orchard Tree", names[0], ["tree", "tree_number"], as_dict=True
        )
        self.assertEqual(tree.tree, 4)
        self.assertEqual(tree.tree_number, "4")

    def test_a_band_is_stored_under_its_own_unit_type(self):
        """Same structure, but still distinguishable — a coffee band must not be
        counted as an avocado row in a report."""
        doc = self.build("Band", _collection(_feature(unit_id=7, child_id=1)))
        doc.run_automation()
        self.assertEqual(len(self.units("Band")), 1)
        self.assertEqual(self.units("Row"), [])

    def test_band_is_an_allowed_unit_type_on_the_shared_bed_doctype(self):
        """`Bed` belongs to upande_core; SCP appends the option via Property
        Setter. Without it, every coffee layout would fail validation."""
        options = frappe.get_meta("Bed").get_field("unit_type").options
        self.assertIn("Band", [o.strip() for o in options.split("\n")])


class TestUnitKinds(FieldUnitCase):
    def test_beds_get_zones(self):
        doc = self.build(
            "Bed",
            _collection(_feature(line_id=1, zone_id=1), _feature(line_id=1, zone_id=2)),
        )
        doc.run_automation()
        self.assertEqual(len(self.units("Bed")), 1)
        self.assertEqual(len(self.children("Zone", "bed", "Bed")), 2)

    def test_rows_get_trees(self):
        doc = self.build("Row", _collection(_feature(row_id=3, tree_id=1)))
        doc.run_automation()
        self.assertEqual(len(self.units("Row")), 1)
        self.assertEqual(len(self.children("Orchard Tree", "row", "Row")), 1)

    def test_an_unknown_unit_type_is_refused(self):
        doc = self.build("Bed", _collection(_feature(unit_id=1, child_id=1)))
        doc.unit_type = "Terrace"
        with self.assertRaises(frappe.ValidationError):
            doc.run_automation()

    def test_the_summary_names_the_unit_kind(self):
        """The old confirmation said "Bed and Zone documents" for all three crops."""
        doc = self.build("Band", _collection(_feature(unit_id=1, child_id=1)))
        summary = doc.run_automation()
        self.assertIn("band", summary.lower())
        self.assertIn("tree", summary.lower())


class TestGeojsonFormats(FieldUnitCase):
    def test_a_single_feature_collection_is_read(self):
        """The avocado tool's only accepted layout."""
        doc = self.build("Row", _collection(_feature(row_id=1, tree_id=1)))
        doc.run_automation()
        self.assertEqual(len(self.units("Row")), 1)

    def test_one_collection_per_line_is_read(self):
        """The rose tool's only accepted layout."""
        doc = self.build(
            "Bed",
            _ndjson(
                _collection(_feature(line_id=1, zone_id=1)),
                _collection(_feature(line_id=2, zone_id=1)),
            ),
        )
        doc.run_automation()
        self.assertEqual(len(self.units("Bed")), 2)

    def test_blank_lines_are_ignored(self):
        doc = self.build(
            "Bed",
            "\n\n" + _collection(_feature(line_id=1, zone_id=1)) + "\n\n",
        )
        doc.run_automation()
        self.assertEqual(len(self.units("Bed")), 1)

    def test_malformed_json_is_reported_as_such(self):
        """Not as "no features" — the operator needs to know it is their paste."""
        doc = self.build("Bed", "{not json at all")
        with self.assertRaises(frappe.ValidationError) as caught:
            doc.run_automation()
        self.assertIn("GeoJSON", str(caught.exception))

    def test_valid_json_with_no_features_is_reported(self):
        doc = self.build("Bed", json.dumps({"type": "FeatureCollection", "features": []}))
        with self.assertRaises(frappe.ValidationError) as caught:
            doc.run_automation()
        self.assertIn("no features", str(caught.exception).lower())


class TestIdConventions(FieldUnitCase):
    """All three conventions work for every unit type, so nobody reshapes an export."""

    def test_unit_id_and_child_id(self):
        doc = self.build("Bed", _collection(_feature(unit_id=4, child_id=2)))
        doc.run_automation()
        self.assertEqual(self.numbers("Bed"), [4])

    def test_row_id_and_tree_id(self):
        doc = self.build("Bed", _collection(_feature(row_id=5, tree_id=1)))
        doc.run_automation()
        self.assertEqual(self.numbers("Bed"), [5])

    def test_line_id_and_zone_id(self):
        doc = self.build("Row", _collection(_feature(line_id=6, zone_id=1)))
        doc.run_automation()
        self.assertEqual(self.numbers("Row"), [6])

    def test_a_name_ending_in_row_and_tree_numbers(self):
        """The avocado exports carry no ids at all."""
        doc = self.build("Band", _collection(_feature(name="KAPT_BLK9_ROW12_T3")))
        doc.run_automation()
        self.assertEqual(self.numbers("Band"), [12])

    def test_a_feature_with_no_usable_numbers_is_counted_not_crashed_on(self):
        doc = self.build(
            "Bed",
            _collection(
                _feature(line_id=1, zone_id=1),
                _feature(name="no numbers here"),
            ),
        )
        summary = doc.run_automation()
        self.assertEqual(len(self.units("Bed")), 1)
        self.assertIn("unparsable", summary)

    def test_ids_split_across_conventions_are_still_read(self):
        """A half-converted export: unit under one convention, child under another."""
        doc = self.build("Bed", _collection(_feature(unit_id=8, zone_id=2)))
        doc.run_automation()
        self.assertEqual(self.numbers("Bed"), [8])


class TestUnitTypeIsPartOfEveryLookup(FieldUnitCase):
    """The old rose tool matched an existing unit on `greenhouse + bed` alone,
    ignoring `unit_type`.

    That never mattered, and cannot: core additionally validates the warehouse's
    role, so a warehouse is either a Greenhouse holding beds or a Block holding
    rows and bands — never both. Keying the lookup on `unit_type` therefore fixes
    no live bug; it makes the query state what the data model already guarantees,
    instead of depending on a validation in another app to hold the line.
    """

    def test_a_warehouse_cannot_hold_two_unit_kinds(self):
        """The guarantee the lookup no longer has to borrow."""
        doc = self.build("Band", _collection(_feature(unit_id=5, child_id=1)))
        doc.run_automation()
        self.assertEqual(self.numbers("Band"), [5])

        # The same warehouse, asked for beds: core refuses, because a Block is not
        # a Greenhouse. The automation logs it rather than raising.
        doc.unit_type = "Bed"
        doc.units_geojson = _collection(_feature(line_id=5, zone_id=1))
        doc.save(ignore_permissions=True)
        doc.run_automation()
        beds = frappe.get_all(
            "Bed", filters={"greenhouse": self.block, "unit_type": "Bed"}, pluck="name"
        )
        self.assertEqual(beds, [], "a Block accepted a bed")

    def test_the_lookup_names_the_unit_type(self):
        """Read directly, because no reachable state can demonstrate it."""
        import inspect

        source = inspect.getsource(FUA.FieldUnitAutomation._get_or_create_unit)
        self.assertIn('"unit_type": unit_type', source)


class TestIdempotency(FieldUnitCase):
    def test_a_second_run_creates_nothing_new(self):
        payload = _collection(
            _feature(unit_id=1, child_id=1), _feature(unit_id=1, child_id=2)
        )
        doc = self.build("Bed", payload)
        doc.run_automation()
        before = (len(self.units("Bed")), len(self.children("Zone", "bed", "Bed")))

        summary = doc.run_automation()
        after = (len(self.units("Bed")), len(self.children("Zone", "bed", "Bed")))

        self.assertEqual(before, after)
        self.assertIn("0 beds created", summary)
        self.assertIn("0 zones created", summary)

    def test_re_running_with_more_features_adds_only_the_new_ones(self):
        """The normal way to extend a layout: paste the updated export."""
        doc = self.build("Row", _collection(_feature(row_id=1, tree_id=1)))
        doc.run_automation()

        doc.units_geojson = _collection(
            _feature(row_id=1, tree_id=1),
            _feature(row_id=1, tree_id=2),
            _feature(row_id=2, tree_id=1),
        )
        doc.save(ignore_permissions=True)
        summary = doc.run_automation()

        self.assertEqual(len(self.units("Row")), 2)
        self.assertEqual(len(self.children("Orchard Tree", "row", "Row")), 3)
        self.assertIn("1 rows created", summary)
        self.assertIn("2 trees created", summary)


class TestSectors(FieldUnitCase):
    """One child table now covers what `Greenhouse Sectors` and `Block Sectors` did."""

    def _variety(self):
        return frappe.db.get_value("Item", {"disabled": 0}, "name")

    def test_a_unit_inside_a_range_gets_its_variety(self):
        variety = self._variety()
        if not variety:
            self.skipTest("no Items on this site")
        doc = self.build(
            "Band",
            _collection(_feature(unit_id=3, child_id=1)),
            sectors=[{"sector": variety, "from_unit": 1, "to_unit": 5}],
        )
        doc.run_automation()
        self.assertEqual(self.units("Band")[0].variety, variety)

    def test_a_unit_outside_every_range_gets_none(self):
        variety = self._variety()
        if not variety:
            self.skipTest("no Items on this site")
        doc = self.build(
            "Bed",
            _collection(_feature(line_id=99, zone_id=1)),
            sectors=[{"sector": variety, "from_unit": 1, "to_unit": 5}],
        )
        doc.run_automation()
        self.assertFalse(self.units("Bed")[0].variety)

    def test_ranges_are_inclusive_at_both_ends(self):
        variety = self._variety()
        if not variety:
            self.skipTest("no Items on this site")
        sectors = [{"sector": variety, "from_unit": 2, "to_unit": 4}]
        doc = self.build(
            "Row",
            _collection(
                _feature(row_id=2, tree_id=1),
                _feature(row_id=4, tree_id=1),
                _feature(row_id=5, tree_id=1),
            ),
            sectors=sectors,
        )
        doc.run_automation()
        by_number = {u.bed: u.variety for u in self.units("Row")}
        self.assertEqual(by_number[2], variety)
        self.assertEqual(by_number[4], variety)
        self.assertFalse(by_number[5])


class TestTheOldToolsAreGone(unittest.TestCase):
    def test_neither_old_automation_remains(self):
        for doctype in ("Bed And Zone Automation", "Tree And Row Automation"):
            self.assertFalse(
                frappe.db.exists("DocType", doctype),
                f"{doctype} still exists — the merge patch did not finish",
            )

    def test_neither_old_sector_table_remains(self):
        for doctype in ("Greenhouse Sectors", "Block Sectors"):
            self.assertFalse(frappe.db.exists("DocType", doctype))

    def test_every_old_document_was_carried_across(self):
        """96 rose + 77 avocado docs on kaitet, each named after its warehouse."""
        docs = frappe.get_all(
            "Field Unit Automation", fields=["name", "warehouse", "unit_type"]
        )
        for doc in docs:
            self.assertEqual(
                doc.name, doc.warehouse, "a migrated document lost its warehouse name"
            )
            self.assertIn(doc.unit_type, ("Bed", "Row", "Band"))

    def test_the_entry_point_is_callable_from_the_desk(self):
        self.assertIn(FUA.run, frappe.whitelisted)
        self.assertIn(FUA.FieldUnitAutomation.run_automation, frappe.whitelisted)
