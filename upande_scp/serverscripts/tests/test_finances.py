"""Crop-protection finance report.

The reconciliation invariant is the important one: every cell must sum back to
the source line amounts. Without it an attribution change can quietly lose or
duplicate money while every other assertion still passes.
"""

import unittest

import frappe

from upande_scp.serverscripts.reports import finances

FROM_DATE, TO_DATE = "2020-01-01", "2030-12-31"


class TestFinances(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.report = finances.chemical_cost_by_target(FROM_DATE, TO_DATE)

    # -- reconciliation ---------------------------------------------------
    def test_cells_reconcile_to_their_row_total(self):
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                cells = sum(c["value"] for c in row["costs"].values())
                self.assertAlmostEqual(
                    cells, row["total"], places=1,
                    msg=f"{farm['farm']} / {row['greenhouse']} cells != total",
                )

    def test_every_cell_splits_into_attributed_plus_split(self):
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                for target, cell in row["costs"].items():
                    self.assertAlmostEqual(
                        cell["attributed"] + cell["split"], cell["value"], places=1,
                        msg=f"{row['greenhouse']} / {target} provenance != value",
                    )

    def test_grand_total_matches_the_source_ledger(self):
        total = frappe.db.sql("""
            SELECT ROUND(SUM(sed.amount), 2)
            FROM `tabStock Entry` se
            JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
            JOIN `tabItem` i ON i.name = sed.item_code
            WHERE se.docstatus = 1
              AND se.purpose IN ('Material Transfer for Manufacture', 'Material Issue')
              AND i.item_group IN ('Chemicals', 'Fertilizers')
        """)[0][0]
        self.assertAlmostEqual(self.report["grand_total"], float(total), delta=2.0)

    def test_kind_totals_sum_to_the_grand_total(self):
        by_kind = sum(self.report["totals_by_kind"].values())
        self.assertAlmostEqual(by_kind, self.report["grand_total"], delta=2.0)

    # -- what the widened purposes bought ---------------------------------
    def test_material_issue_spend_is_now_counted(self):
        """~9.1M of store-issued foliar was invisible while the report read
        only Material Transfer for Manufacture."""
        self.assertTrue(self.report["unattributed"], "no unattributed spend reported")
        self.assertGreater(sum(u["value"] for u in self.report["unattributed"]), 0)

    def test_foliar_spend_is_visible(self):
        self.assertGreater(
            self.report["totals_by_kind"].get("foliar", 0), 0,
            "foliar spend is still missing from the report",
        )

    # -- correctness of attribution ---------------------------------------
    def test_foliar_never_lands_in_a_pest_column(self):
        pests = set(frappe.get_all("Pest", pluck="name"))
        diseases = set(frappe.get_all("Plant Disease", pluck="name"))
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                if row["kind"] != "foliar":
                    continue
                for target, cell in row["costs"].items():
                    if cell["value"]:
                        self.assertNotIn(
                            target, pests | diseases,
                            f"foliar cost landed on the pest/disease {target}",
                        )

    def test_split_cells_name_the_untargeted_products(self):
        found = False
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                for target, cell in row["costs"].items():
                    if cell["split"] > 0:
                        found = True
                        self.assertTrue(
                            cell["split_items"],
                            f"split cell {row['greenhouse']}/{target} names no items",
                        )
        self.assertTrue(found, "expected at least one split cell on this dataset")

    def test_store_issued_foliar_is_unattributed_not_nutrition(self):
        """A foliar issued from the store has no work order, so no greenhouse
        and no target. It must be reported as Unattributed, not given a
        Nutrition bucket under a greenhouse that never received it."""
        foliar_unattributed = sum(
            u["value"] for u in self.report["unattributed"] if u["kind"] == "foliar"
        )
        self.assertGreater(
            foliar_unattributed, 5_000_000,
            "store-issued foliar spend is not being reported as unattributed",
        )

    def test_no_row_is_attributed_to_a_missing_greenhouse(self):
        """Every greenhouse row must come from a real work order."""
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                self.assertNotEqual(
                    row["greenhouse"], "—",
                    f"{farm['farm']} has a row with no greenhouse — "
                    "unattributed spend leaked into the greenhouse table",
                )

    def test_untargeted_items_are_listed(self):
        self.assertTrue(self.report["untargeted_items"])
        for entry in self.report["untargeted_items"]:
            self.assertIn(entry["kind"], ("chemical", "foliar"))
            self.assertGreater(entry["value"], 0)

    def test_excluded_purposes_stay_excluded(self):
        """Manufacture would double-count the transfer that filled WIP;
        Material Transfer moves stock between stores without consuming it."""
        excluded = frappe.db.sql("""
            SELECT ROUND(SUM(sed.amount), 2)
            FROM `tabStock Entry` se
            JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
            JOIN `tabItem` i ON i.name = sed.item_code
            WHERE se.docstatus = 1
              AND se.purpose IN ('Manufacture', 'Material Transfer')
              AND i.item_group IN ('Chemicals', 'Fertilizers')
        """)[0][0]
        self.assertGreater(float(excluded or 0), 0, "fixture check: expected excluded spend")
        self.assertLess(self.report["grand_total"], 22_000_000)

    def test_split_items_can_be_resolved_to_readable_names(self):
        """The report names untargeted products by item code; the page must be
        able to show "Magnum Gold", not "CHE00058"."""
        self.assertTrue(self.report["item_names"])
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                for cell in row["costs"].values():
                    for code in cell["split_items"]:
                        self.assertIn(
                            code, self.report["item_names"],
                            f"{code} has no name in item_names",
                        )
                        self.assertTrue(self.report["item_names"][code])
