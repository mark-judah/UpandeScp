"""Crop-protection finance report.

The reconciliation invariant is the important one: targets + unattributed must
equal total spend. Without it an allocation change can quietly lose or duplicate
money while every other assertion still passes.

The allocation tests are pure (they feed `_build` stock lines and a plan
coverage map); one test reads the real site to prove the invariant on live data.
"""

import unittest

import frappe

from upande_scp.serverscripts.reports import finances


def line(code, value, *, wo="WO-1", gh="GH1", kind_group="Chemicals", purpose="Material Transfer for Manufacture",
         date="2026-09-03", ledger=True, s_warehouse="Main Store - X", farm="Farm A", targets="Mites"):
    return {
        "stock_entry": "STE-1", "posting_date": date, "stock_entry_type": purpose, "purpose": purpose,
        "work_order": wo, "s_warehouse": s_warehouse, "item_code": code, "qty": 1, "stock_uom": "Nos",
        "line_amount": value if not ledger else 0, "ledger_value": value if ledger else None,
        "cost_center": "CC", "item_group": kind_group, "item_name": code.title(),
        "greenhouse": gh, "targets": targets, "gh_farm": farm, "src_farm": None,
    }


KINDS = {"Mites": "pest", "Thrips": "pest", "Mildew": "disease", "Botrytis": "disease"}


def build(lines, facts=None, **kw):
    return finances._build(
        lines,
        classify=lambda g: "foliar" if g == "Fertilizers" else "chemical",
        is_wip=lambda w: "CSU" in (w or ""),
        facts=facts or {},
        kinds=KINDS,
        granularity="week",
        **kw,
    )


def reg(*targets, **extra):
    return {"registered": list(targets), **extra}


class TestAllocation(unittest.TestCase):
    def test_registered_targets_split_evenly(self):
        r = build([line("a", 100, targets="Mites\nThrips\nMildew")], {"a": reg("Mites", "Thrips")})
        got = {t["target"]: t["value"] for t in r["cost_per_target"]}
        self.assertEqual(got, {"Mites": 50.0, "Thrips": 50.0})
        self.assertEqual(r["unattributed_total"], 0)

    def test_no_targets_is_unattributed(self):
        r = build([line("a", 70, wo=None, gh=None, purpose="Material Issue", targets=None)])
        self.assertEqual(r["unattributed"][0]["reason"], "no_plan")
        self.assertEqual(r["cost_per_target"], [])
        self.assertEqual(r["by_basis"][-1]["value"], 70.0)

    def test_foliar_goes_to_the_nutrition_line(self):
        r = build([line("f", 40, kind_group="Fertilizers", targets="Mites")])
        self.assertEqual(r["cost_per_target"][0]["target"], finances.FA.NUTRITION)
        self.assertEqual(r["cost_per_target"][0]["kind"], "nutrition")

    def test_everything_reconciles(self):
        lines = [line("a", 100, targets="Mites\nMildew"), line("b", 40, targets="Mites"),
                 line("c", 33.33, wo=None, gh=None, purpose="Material Issue"),
                 line("f", 61.7, wo="WO-2", gh="GH2", kind_group="Fertilizers", targets="Thrips"),
                 line("a", 12.34, wo="WO-3", targets="Thrips\nMildew\nBotrytis")]
        facts = {"a": reg("Mites"), "b": {"irac": True}}
        r = build(lines, facts)
        self.assertAlmostEqual(r["grand_total"], 247.37, places=2)
        self.assertAlmostEqual(r["reconciliation"]["difference"], 0, places=2)
        self.assertAlmostEqual(sum(t["value"] for t in r["cost_per_target"]) + r["unattributed_total"], r["grand_total"], delta=0.03)
        self.assertAlmostEqual(sum(b["value"] for b in r["by_basis"]), r["grand_total"], places=2)
        for key in ("by_product", "by_place", "by_period"):
            self.assertAlmostEqual(sum(p["value"] for p in r[key]), r["grand_total"], places=2)

    def test_out_of_a_csu_is_not_counted_again(self):
        r = build([line("a", 100, purpose="Material Issue", s_warehouse="CSU 1 - X")])
        self.assertEqual(r["grand_total"], 0)

    def test_excluded_types_stay_excluded(self):
        r = build([line("a", 100, purpose="Manufacture"), line("a", 9, purpose="Material Receipt")])
        self.assertEqual(r["grand_total"], 0)

    def test_zero_valuation_is_listed_not_silent(self):
        r = build([line("a", 0)])
        self.assertEqual(len(r["no_valuation"]), 1)

    def test_ledger_value_beats_line_amount(self):
        row = line("a", 100)
        row["line_amount"] = 999
        self.assertEqual(build([row])["grand_total"], 100.0)

    def test_periods_bucket_by_week(self):
        r = build([line("a", 10, date="2026-09-01"), line("a", 5, date="2026-09-09")])
        self.assertEqual([p["period"] for p in r["by_period"]], ["2026-08-31", "2026-09-07"])


class TestLive(unittest.TestCase):
    def test_site_totals_reconcile(self):
        frappe.set_user("Administrator")
        r = finances.chemical_cost_by_target("2026-09-01", "2026-09-30")
        self.assertAlmostEqual(r["reconciliation"]["difference"], 0, delta=0.05)
        self.assertAlmostEqual(
            sum(t["value"] for t in r["cost_per_target"]) + r["unattributed_total"], r["grand_total"], delta=0.05
        )
