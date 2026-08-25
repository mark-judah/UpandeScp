"""Seeding Chemical metadata from the Plant Protection Products book.

Figures are the ones surveyed on 2026-08-25 against this workbook and this
site. If one moves, the input changed — investigate rather than loosen the
assertion.
"""

import unittest

import frappe

from upande_scp.serverscripts.ppp_book import parse, seed


class TestPPPSeed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.report = seed.seed_from_book(dry_run=True)

    # -- coverage --------------------------------------------------------
    def test_dry_run_reports_expected_coverage(self):
        self.assertEqual(self.report["matched"], 54)
        self.assertEqual(len(self.report["uncovered"]), 24)

    def test_sulphuric_acid_gains_no_target(self):
        """Inferring an active from an item NAME is rejected: sulphuric acid is
        a pH adjuster, not a sulphur fungicide. It must stay uncovered."""
        self.assertIn("CHE00006", self.report["uncovered"])

    def test_fuzzy_cutoff_keeps_distinct_products_apart(self):
        """DIPNOY (in the book) and DIPLOY (mona's item) are different products
        at 0.83 similarity. Matching them would attribute one's targets to the
        other."""
        self.assertIn("CHE00018", self.report["uncovered"])

    def test_conflicting_book_products_are_not_in_the_catalogue(self):
        """The book's two cross-sheet target conflicts (APPLAUD, DIPNOY) involve
        products mona does not stock, so no conflict reaches the data."""
        self.assertEqual(self.report["conflicts"], [])

    # -- provenance ------------------------------------------------------
    def test_equator_sheet_never_supplies_a_rate(self):
        for r in parse.parse_workbook():
            if r["sheet"] != parse.MONA_SHEET:
                self.assertEqual((r["rate_low"], r["rate_high"]), (None, None))
                self.assertIsNone(r["toxicity"])

    # -- written data ----------------------------------------------------
    def test_targets_were_actually_written(self):
        with_targets = frappe.db.sql("""
            SELECT COUNT(*) FROM `tabChemical` c
            WHERE EXISTS (SELECT 1 FROM `tabChemical Targets` t
                          WHERE t.parent = c.name AND t.parenttype = 'Chemical')
        """)[0][0]
        self.assertGreaterEqual(with_targets, 55)

    def test_active_ingredients_recover_multi_target_products(self):
        """Each sheet files a product under one heading, so name matching alone
        gives zero multi-target products. The actives restore them."""
        multi = frappe.db.sql("""
            SELECT COUNT(*) FROM (
                SELECT parent FROM `tabChemical Targets`
                WHERE parenttype = 'Chemical'
                GROUP BY parent HAVING COUNT(*) > 1
            ) x
        """)[0][0]
        self.assertGreaterEqual(multi, 11)

    def test_seed_is_fill_blanks_only(self):
        name = frappe.db.get_value("Chemical", {"item": "CHE00043"}, "name")
        self.assertTrue(name)
        doc = frappe.get_doc("Chemical", name)
        before = doc.formulation
        doc.formulation = "SENTINEL"
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        try:
            seed.seed_from_book()
            self.assertEqual(
                frappe.db.get_value("Chemical", name, "formulation"), "SENTINEL",
                "the loader overwrote a populated field",
            )
        finally:
            doc = frappe.get_doc("Chemical", name)
            doc.formulation = before
            doc.save(ignore_permissions=True)
            frappe.db.commit()

    def test_pest_master_is_created_for_a_stocked_product(self):
        """`Nematodes` is the one alias with no pre-existing Pest master. mona
        stocks VELUM PRIME 400SC, a nematicide, so the master must be created
        and linked. `Pest` autonames from `common_name`, not `pest_name` —
        getting that wrong fails naming and, because the caller is
        failure-isolated, silently costs the product ALL its targets."""
        seed.seed_from_book()
        self.assertEqual(frappe.db.count("Pest", {"name": "Nematodes"}), 1)
        targets = frappe.get_all(
            "Chemical Targets",
            filters={"parent": "CHE00010", "parenttype": "Chemical"},
            pluck="pest",
        )
        self.assertIn("Nematodes", targets)

    def test_reseeding_creates_no_duplicates(self):
        before = frappe.db.count("Pest")
        targets_before = frappe.db.count("Chemical Targets", {"parenttype": "Chemical"})
        seed.seed_from_book()
        seed.seed_from_book()
        self.assertEqual(frappe.db.count("Pest"), before)
        self.assertEqual(
            frappe.db.count("Chemical Targets", {"parenttype": "Chemical"}),
            targets_before,
            "re-running the loader duplicated target rows",
        )

    def test_unknown_codes_are_reported_not_invented(self):
        """FRAC 27 and P7 are real groups absent from mona's code master. The
        loader must report them, never create a resistance-group record."""
        report = seed.seed_from_book()
        for entry in report["unknown_codes"]:
            self.assertFalse(
                frappe.db.exists("FRAC Code", entry["code"])
                or frappe.db.exists("IRAC Code", entry["code"]),
                f"{entry['code']} was reported unknown but exists",
            )
