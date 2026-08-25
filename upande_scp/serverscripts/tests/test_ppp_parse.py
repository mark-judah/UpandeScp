"""Parsing of the Plant Protection Products workbook.

Pure — no site needed. The counts assert the workbook shape surveyed on
2026-08-25; if one changes, the workbook changed and the seeding figures in the
spec need re-checking rather than the assertion loosening.
"""

import unittest

from upande_scp.serverscripts.ppp_book import parse


class TestPPPParse(unittest.TestCase):
    # -- active ingredients ---------------------------------------------
    def test_split_actives_strips_concentrations(self):
        self.assertEqual(
            parse.split_actives("Metalaxyl-M 40g/Kg + Mancozeb 640g/Kg"),
            ["metalaxyl-m", "mancozeb"],
        )

    def test_split_actives_normalises_spelling(self):
        self.assertEqual(parse.split_actives("Sulfur 800 g/kg"), ["sulphur"])
        self.assertEqual(parse.split_actives("Sulphur 800g/kg"), ["sulphur"])

    def test_split_actives_handles_empty(self):
        self.assertEqual(parse.split_actives(""), [])
        self.assertEqual(parse.split_actives(None), [])

    # -- FRAC / IRAC codes ----------------------------------------------
    def test_normalise_codes_splits_premixed(self):
        self.assertEqual(parse.normalise_codes("4 + M 03"), ["4", "M3"])
        self.assertEqual(parse.normalise_codes("M 01"), ["M1"])
        self.assertEqual(parse.normalise_codes("27 + 11"), ["27", "11"])

    def test_normalise_codes_fixes_prac_typo(self):
        self.assertEqual(parse.normalise_codes("PRAC 33 + FRAC 11"), ["33", "11"])

    def test_normalise_codes_keeps_lettered_groups(self):
        self.assertEqual(parse.normalise_codes("22A"), ["22A"])
        self.assertEqual(parse.normalise_codes("10A"), ["10A"])
        self.assertEqual(parse.normalise_codes("P 07"), ["P7"])

    def test_frac_11_survives_but_mangled_111_does_not(self):
        """FRAC 11 (QoI / strobilurins) is a real, common group in this book.
        The three-digit 111 is a Roman numeral that leaked from the WHO column."""
        self.assertEqual(parse.normalise_codes("11"), ["11"])
        self.assertEqual(parse.normalise_codes("111"), [])

    def test_normalise_codes_drops_non_codes(self):
        for junk in ("ADJUVANT", "BROADRANGE", "NEEMEXTRACT", "PHT", "UNE", "N-UNE", "U"):
            self.assertEqual(parse.normalise_codes(junk), [], f"{junk} should be dropped")

    # -- toxicity --------------------------------------------------------
    def test_repair_toxicity_roman_numerals(self):
        self.assertEqual(parse.repair_toxicity("11"), "II")
        self.assertEqual(parse.repair_toxicity("111"), "III")
        self.assertEqual(parse.repair_toxicity("II"), "II")

    def test_repair_toxicity_rejects_unusable(self):
        for junk in ("U", "-", "N/A", "", None):
            self.assertIsNone(parse.repair_toxicity(junk), f"{junk!r} should be None")

    # -- rates -----------------------------------------------------------
    def test_parse_rate_range_and_single(self):
        self.assertEqual(parse.parse_rate("2 - 2.25 g/l"), (2.0, 2.25))
        self.assertEqual(parse.parse_rate("2 g/l"), (2.0, 2.0))
        self.assertEqual(parse.parse_rate("0.4 - 0.5 m/l"), (0.4, 0.5))
        self.assertEqual(parse.parse_rate(""), (None, None))

    # -- target aliases --------------------------------------------------
    def test_target_aliases_cover_the_awkward_sections(self):
        self.assertEqual(parse.TARGET_ALIASES["downey mildew"], ["Downy Mildew"])
        self.assertEqual(parse.TARGET_ALIASES["mites"], ["Spidermites"])
        self.assertEqual(parse.TARGET_ALIASES["aphids/ m bugs"], ["Aphids", "Mealybugs"])
        self.assertEqual(parse.TARGET_ALIASES["agrobacteria"], ["Agrobacterium"])
        self.assertEqual(parse.TARGET_ALIASES["p/harvest"], [])

    # -- the workbook itself ---------------------------------------------
    def test_norm_product_splits_glued_strength_and_formulation(self):
        """The item master glues them ("MAINSPRING 200SC"), the book spaces them
        ("MAINSPRING 200 SC"). Without splitting digit/letter runs the
        word-boundary strippers never fire and the two never match — that alone
        cost 8 of 104 product matches."""
        self.assertEqual(
            parse.norm_product("MAINSPRING 200SC"), parse.norm_product("MAINSPRING 200 SC")
        )
        self.assertEqual(
            parse.norm_product("DELEGATE 250WG"), parse.norm_product("Delegate 250 wg")
        )
        self.assertEqual(parse.norm_product("NOMOLT150SC"), "nomolt")

    def test_workbook_shape_is_as_surveyed(self):
        rows = parse.parse_workbook()
        self.assertEqual(len(rows), 216)
        self.assertEqual(sum(1 for r in rows if r["sheet"] == parse.MONA_SHEET), 119)

    def test_equator_sheet_supplies_no_rate_or_toxicity(self):
        for r in parse.parse_workbook():
            if r["sheet"] != parse.MONA_SHEET:
                self.assertEqual((r["rate_low"], r["rate_high"]), (None, None))
                self.assertIsNone(r["toxicity"])

    def test_active_target_map_recovers_multi_target_actives(self):
        amap = parse.active_target_map(parse.parse_workbook())
        self.assertEqual(
            amap["azoxystrobin"], {"Botrytis", "Downy Mildew", "Powdery Mildew"}
        )
        self.assertIn("Thrips", amap["pyrethrins"])
        self.assertIn("Aphids", amap["pyrethrins"])

    def test_buprofezin_spans_the_applaud_conflict(self):
        """Sheet1 files APPLAUD under Aphids/M Bugs, Sheet2 under Caterpillars.
        Buprofezin is active across those groups, so the union is correct and
        neither sheet has to lose."""
        amap = parse.active_target_map(parse.parse_workbook())
        self.assertTrue({"Aphids", "Mealybugs"} & amap["buprofezin"])
        self.assertIn("Caterpillars", amap["buprofezin"])
