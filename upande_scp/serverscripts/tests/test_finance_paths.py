"""Completed-plan detection, attribution reconciliation, report blocks and the Excel export."""

import io
import unittest
from datetime import datetime
from unittest import mock

import openpyxl

from upande_scp.serverscripts.reports import finance_api as API
from upande_scp.serverscripts.reports import finance_attribution as FAT
from upande_scp.serverscripts.reports import finance_paths as FP

KB = {"alias": {}, "kind": {"abamectin": "Insecticide"}, "ai_t": {"abamectin": {"Mites": 1}}, "prod_ai": {}, "prods": {}}
KINDS = {"Mites": "pest", "Thrips": "pest", "Mildew": "disease"}


def M(wo, day, wh="GH1", qty=1.2, item="MIX", h=8):
	return {"wo": wo, "name": f"M-{wo}", "dt": datetime(2026, 9, day, h), "item": item, "warehouse": wh, "qty": qty}


def I(name, day, wh="GH1", qty=1.2, item="MIX", h=12):
	return {"name": name, "dt": datetime(2026, 9, day, h), "item": item, "warehouse": wh, "qty": qty}


class TestCompletedPlans(unittest.TestCase):
	def test_manufacture_with_matching_issue_is_complete(self):
		self.assertEqual(FP.match_completed([M("A", 3)], [I("MI1", 3)])["A"]["name"], "MI1")

	def test_manufacture_without_issue_is_not_complete(self):
		self.assertEqual(FP.match_completed([M("A", 3)], []), {})

	def test_issue_from_another_greenhouse_or_quantity_does_not_match(self):
		self.assertEqual(FP.match_completed([M("A", 3)], [I("X", 3, wh="GH2")]), {})
		self.assertEqual(FP.match_completed([M("A", 3)], [I("X", 3, qty=1.0)]), {})

	def test_issue_before_the_manufacture_does_not_match(self):
		self.assertEqual(FP.match_completed([M("A", 5)], [I("X", 4)]), {})

	def test_issue_too_long_after_does_not_match(self):
		self.assertEqual(FP.match_completed([M("A", 1)], [I("X", 1)] and [{**I("X", 1), "dt": datetime(2026, 11, 1)}]), {})

	def test_each_issue_used_once_earliest_first(self):
		got = FP.match_completed([M("A", 3), M("B", 3, h=9)], [I("MI1", 3), I("MI2", 4)])
		self.assertEqual((got["A"]["name"], got["B"]["name"]), ("MI1", "MI2"))

	def test_second_plan_without_its_own_issue_stays_in_progress(self):
		got = FP.match_completed([M("A", 3), M("B", 3, h=9)], [I("MI1", 3)])
		self.assertEqual(set(got), {"A"})


def line(path="spray", code="P1", value=100.0, **kw):
	base = {"path": path, "date": "2026-09-10", "document": "D1", "issue": "I1", "work_order": "WO1" if path == "spray" else None,
	        "mr": None, "link_basis": "Greenhouse+date (matched)" if path == "spray" else None, "greenhouse": "GH1" if path == "spray" else None, "farm": "F", "cost_center": "CC1",
	        "item_code": code, "item_name": code, "qty": 1, "uom": "L", "value": value, "ledger": True,
	        "detail": "d", "share": 1.0, "is_return": False, "netted_against": None,
	        "plan_targets": ["Mites", "Mildew"] if path == "spray" else None, "recorded": []}
	base.update(kw)
	return base


PRODUCTS = {
	"P1": {"code": "P1", "name": "Chem", "category": "Chemical", "type": "Insecticide", "ingredients": ["abamectin"]},
	"P2": {"code": "P2", "name": "Plain chem", "category": "Chemical", "type": "Fungicide"},
	"F1": {"code": "F1", "name": "Foliar feed", "category": "Foliar"},
	"A1": {"code": "A1", "name": "Wetter", "category": "Chemical", "type": "Adjuvant"},
	"H1": {"code": "H1", "name": "Sanitiser", "category": "Chemical", "type": "Insecticide", "cost_group": "Hygiene & sanitation"},
	"PH": {"code": "PH", "name": "Vase life", "category": "Chemical", "type": "Insecticide", "cost_group": "Post-harvest"},
	"U1": {"code": "U1", "name": "Mystery", "category": "Chemical", "type": "Insecticide"},
}
REFS = {"plans": {}, "mona_ai_t": {}, "use_dates": {"P2": [(f"2026-08-0{i}", f"W{i}") for i in range(1, 5)]}}


def attr(lines):
	return FP.attribute(lines, REFS, KB, KINDS, PRODUCTS)


class TestAttribution(unittest.TestCase):
	def test_rows_sum_to_line_values_to_the_cent(self):
		lines = [line(code="P2", value=100.01), line(code="F1", value=33.33, plan_targets=["Mites", "Thrips", "Mildew"]),
		         line("direct", "P2", 50.0), line("direct", "F1", 20.0)]
		rows = attr(lines)
		self.assertAlmostEqual(sum(r["attributed"] for r in rows), sum(ln["value"] for ln in lines), places=6)

	def test_recorded_line_is_recorded_with_100_percent(self):
		rows = attr([line(code="P2", value=90, recorded=["Mildew"])])
		self.assertEqual([(r["target"], r["basis"], r["credibility"], r["accuracy"]) for r in rows],
		                 [("Mildew", "recorded", "recorded", 1.0)])

	def test_foliar_separate_and_equal_on_spray_farm_level_on_direct(self):
		rows = attr([line(code="F1", value=100), line("direct", "F1", 40)])
		spray = [r for r in rows if r["path"] == "spray"]
		self.assertEqual({(r["target"], r["attributed"]) for r in spray}, {("Mites", 50.0), ("Mildew", 50.0)})
		self.assertTrue(all(r["is_nonpest"] for r in rows))
		d = [r for r in rows if r["path"] == "direct"]
		self.assertEqual([(r["target"], r["basis"]) for r in d], [("Foliar", "foliar_farm")])

	def test_hygiene_and_post_harvest_are_their_own_lines_on_both_paths(self):
		rows = attr([line(code="H1", value=30), line("direct", "PH", 20)])
		self.assertEqual([(r["target"], r["basis"], r["group"]) for r in rows],
		                 [("Hygiene & sanitation", "non_pest", "Hygiene & sanitation"), ("Post-harvest", "non_pest", "Post-harvest")])

	def test_unclassified_is_its_own_line_and_plan_uses_travel_with_the_row(self):
		rows = attr([line("direct", "U1", 12), line("direct", "P2", 8)])
		u = rows[0]
		self.assertEqual((u["target"], u["basis"], u["is_nonpest"], u["plan_uses"]), ("Unclassified", "unclassified", True, 0))
		self.assertEqual(rows[1]["plan_uses"], 4)

	def test_unattributed_direct_chemical(self):
		rows = attr([line("direct", "P2", 70)])
		self.assertEqual([(r["target"], r["basis"]) for r in rows], [(FP.UNATTRIBUTED, "unattributed")])


class TestBlocks(unittest.TestCase):
	def rows(self):
		return attr([
			line(code="P2", value=100, recorded=["Mites"]),
			line(code="P1", value=60),
			line(code="F1", value=40),
			line("direct", "P2", 25),
			line("direct", "F1", 15),
		])

	def test_non_pest_groups_never_in_chemical_totals(self):
		rows = self.rows() + attr([line(code="A1", value=10), line(code="H1", value=5)])
		b = FP._block([r for r in rows if r["path"] == "spray"])
		self.assertEqual(b["chemical"]["total"], 160.0)
		groups = {g["group"]: g for g in b["nonpest"]["groups"]}
		self.assertEqual(set(groups), set(FAT.NON_PEST_GROUPS))
		self.assertEqual((groups["Foliar"]["value"], groups["Adjuvant"]["value"], groups["Hygiene & sanitation"]["value"]), (40.0, 10.0, 5.0))
		self.assertIn("split equally", groups["Adjuvant"]["treatment"])
		self.assertIn("never split", groups["Hygiene & sanitation"]["treatment"])
		self.assertEqual(b["nonpest"]["total"], 55.0)
		self.assertEqual(b["total"], 215.0)
		b = FP._block([r for r in self.rows() if r["path"] == "spray"])
		self.assertEqual(b["total"], 200.0)
		self.assertEqual(sum(p["value"] for p in b["chemical"]["by_pest"]), 160.0)

	def test_recorded_and_derived_are_separate_columns(self):
		b = FP._block([r for r in self.rows() if r["path"] == "spray"])
		mites = next(p for p in b["chemical"]["by_pest"] if p["target"] == "Mites")
		self.assertEqual(mites["recorded"], 100.0)
		self.assertEqual(mites["derived"], 60.0)  # P1 -> ingredient target Mites, band1_ai_target
		self.assertEqual(mites["value"], 160.0)
		self.assertAlmostEqual(b["chemical"]["derived_accuracy"], 0.89)

	def test_unattributed_separate(self):
		b = FP._block([r for r in self.rows() if r["path"] == "direct"])
		self.assertEqual(b["chemical"]["unattributed"], 25.0)
		self.assertEqual(next(g for g in b["nonpest"]["groups"] if g["group"] == "Foliar")["farm_level"], 15.0)

	def test_filters(self):
		rows = self.rows()
		got, notes = FP.apply_filters(rows, paths=("direct",))
		self.assertTrue(all(r["path"] == "direct" for r in got))
		got, notes = FP.apply_filters(rows, paths=("spray", "direct"), greenhouse="GH1")
		self.assertTrue(all(r["path"] == "spray" for r in got) and notes)
		got, _ = FP.apply_filters(rows, pests=["Mites"])
		self.assertEqual({r["target"] for r in got}, {"Mites"})
		got, _ = FP.apply_filters(rows, pests=["Mites", FP.NONPEST])
		self.assertTrue(any(r["is_nonpest"] for r in got))


class TestExport(unittest.TestCase):
	def setUp(self):
		lines = [line(code="P2", value=100, recorded=["Mites"], detail="a"), line(code="P1", value=60, detail="b"),
		         line(code="F1", value=40, detail="c"), line("direct", "P2", 25, detail="d", mr="MR-1"),
		         line("direct", "F1", 15, detail="e")]
		self.data = {"rows": attr(lines), "lines": lines, "spray": {"in_progress": [{"work_order": "W", "value": 10.0, "greenhouse": "GH1", "targets": []}], "straddle": [], "not_issued": [], "manufactured": 0, "by_link": {}}, "kinds": KINDS}
		self.lines = lines

	def build(self, **kw):
		with mock.patch.object(FP, "collect_rows", return_value=self.data), \
		     mock.patch.object(FP, "ledger_total", side_effect=lambda ls: sum(x["value"] for x in ls)):
			content, sheets = API.build_workbook("2026-09-01", "2026-09-30", **kw)
		return openpyxl.load_workbook(io.BytesIO(content)), sheets

	def test_sheets_present_and_product_sheet_only_when_asked(self):
		wb, _ = self.build(per_product=False)
		self.assertEqual(wb.sheetnames, ["Summary", "By greenhouse", "Lines"])
		wb, _ = self.build(per_product=True)
		self.assertEqual(wb.sheetnames, ["Summary", "By greenhouse", "By product", "Lines"])

	def test_lines_sum_to_summary_totals(self):
		wb, _ = self.build()
		lines = wb["Lines"]
		head = [c.value for c in lines[1]]
		col = head.index("Attributed value")
		total_lines = round(sum(r[col] for r in lines.iter_rows(min_row=2, values_only=True)), 2)
		table = list(wb["Summary"].iter_rows(values_only=True))
		start = next(i for i, r in enumerate(table) if r[0] == "Totals by path")
		summ = {r[0]: r for r in table[start:start + 6] if r and r[0]}
		self.assertEqual(total_lines, round(sum(ln["value"] for ln in self.lines), 2))
		self.assertEqual(round(summ["Total"][-1], 2), total_lines)
		self.assertEqual(summ["Spray plan"][-1], 200.0)
		self.assertEqual(summ["Direct issue"][-1], 40.0)

	def test_foliar_in_own_columns_and_credibility_columns(self):
		wb, _ = self.build()
		head = [c.value for c in wb["Lines"][1]]
		for h in ("Link basis", "Cost group", "Recorded value", "Derived value", "Non-pest inputs", "Basis", "Credibility", "Est. accuracy"):
			self.assertIn(h, head)
		rows = list(wb["Lines"].iter_rows(min_row=2, values_only=True))
		bi, ci, ai = head.index("Basis"), head.index("Credibility"), head.index("Est. accuracy")
		labels = {r[ci] for r in rows}
		self.assertIn("Recorded", labels)
		self.assertTrue(any(x.startswith("Derived") and "est. 89%" in x for x in labels))
		self.assertIn("Split equally across plan targets", labels)
		rec = next(r for r in rows if r[bi] == "recorded")
		self.assertEqual(rec[ai], 1.0)

	def test_filters_echoed_and_path_filter(self):
		wb, _ = self.build(paths=("direct",), pests=["Mites"])
		text = [r for r in wb["Summary"].iter_rows(values_only=True)]
		flat = [c for r in text for c in r if c]
		self.assertIn("Direct issue", flat)
		self.assertIn("Mites", flat)
		self.assertNotIn("Spray plan", [r[0] for r in text if r[0] == "Spray plan"])

	def test_direct_is_farm_level_in_greenhouse_sheet(self):
		wb, _ = self.build()
		rows = list(wb["By greenhouse"].iter_rows(min_row=2, values_only=True))
		self.assertTrue(any(r[0] == "Direct issue" and r[2] == FP.FARM_LEVEL for r in rows))

	def test_header_rows_only_are_styled(self):
		wb, _ = self.build()
		ws = wb["Lines"]
		self.assertTrue(ws["A1"].font.bold)
		self.assertFalse(ws["A2"].font.bold)
		self.assertEqual(ws["A2"].number_format, "General")

	def test_money_columns_carry_the_number_format_and_shares_percent(self):
		wb, _ = self.build(per_product=True)
		ws = wb["Lines"]
		head = [c.value for c in ws[1]]
		for h in ("Line value", "Recorded value", "Derived value", "Non-pest inputs", "Unattributed value", "Attributed value"):
			self.assertEqual(ws.cell(2, head.index(h) + 1).number_format, "#,##0.00", h)
		self.assertEqual(ws.cell(2, head.index("Share") + 1).number_format, "0.0%")
		self.assertEqual(ws.cell(2, head.index("Qty") + 1).number_format, "General")
		g = wb["By greenhouse"]
		gh = [c.value for c in g[1]]
		self.assertEqual(g.cell(2, gh.index("Total") + 1).number_format, "#,##0.00")
		pr = wb["By product"]
		ph = [c.value for c in pr[1]]
		self.assertEqual(pr.cell(2, ph.index("Total") + 1).number_format, "#,##0.00")
		summ = list(wb["Summary"].iter_rows())
		start = next(i for i, r in enumerate(summ) if r[0].value == "Totals by path")
		self.assertEqual(summ[start + 2][1].number_format, "#,##0.00")
		self.assertEqual(summ[start + 2][3].number_format, "0.0%")

	def test_summary_has_a_line_per_non_pest_group(self):
		wb, _ = self.build()
		flat = [c for r in wb["Summary"].iter_rows(values_only=True) for c in r if c]
		for g in FAT.NON_PEST_GROUPS:
			self.assertIn(g, flat)
		self.assertTrue(any("never split to pests" in str(c) for c in flat))

	def test_direct_lines_say_whether_the_product_is_also_used_in_spray_plans(self):
		wb, _ = self.build()
		ws = wb["Lines"]
		head = [c.value for c in ws[1]]
		col = head.index("Also used in spray plans")
		vals = {(r[head.index("Path")], r[head.index("Item code")]): r[col] for r in ws.iter_rows(min_row=2, values_only=True)}
		self.assertEqual(vals[("Direct issue", "P2")], "Yes (4 plans)")
		self.assertEqual(vals[("Direct issue", "F1")], "No")
		self.assertFalse(vals[("Spray plan", "P2")])


class TestSplitIssuesAndValuation(unittest.TestCase):
	def test_issue_shares_follow_issued_quantity_and_sum_to_one(self):
		got = FP.split_issue_shares([{"qty": 1.2, "name": "A"}, {"qty": 0.8, "name": "B"}])
		self.assertEqual([(i["name"], round(s, 6)) for i, s in got], [("A", 0.6), ("B", 0.4)])
		self.assertAlmostEqual(sum(s for _i, s in got), 1.0)

	def test_a_single_issue_takes_everything_and_zero_quantity_splits_evenly(self):
		self.assertEqual(FP.split_issue_shares([{"qty": 2}])[0][1], 1.0)
		self.assertEqual([s for _i, s in FP.split_issue_shares([{"qty": 0}, {"qty": 0}])], [0.5, 0.5])

	def test_zero_ledger_value_falls_back_to_the_line_amount_and_is_counted(self):
		self.assertEqual(FP.valuation({"ledger_value": 0, "qty": 3, "line_amount": 120}), (120.0, False))
		self.assertEqual(FP.valuation({"ledger_value": None, "qty": 3, "line_amount": 50}), (50.0, False))
		self.assertEqual(FP.valuation({"ledger_value": 80, "qty": 3, "line_amount": 120}), (80.0, True))
		self.assertEqual(FP.valuation({"ledger_value": 0, "qty": 0, "line_amount": 0}), (0.0, True))

	def test_split_lines_attribute_to_the_value_of_each_part(self):
		a = line(value=60.0, greenhouse="GH1", detail="d")
		b = line(value=40.0, greenhouse="GH2", detail="d")
		rows = attr([a, b])
		by_gh = {}
		for r in rows:
			by_gh[r["greenhouse"]] = by_gh.get(r["greenhouse"], 0) + r["attributed"]
		self.assertEqual(by_gh, {"GH1": 60.0, "GH2": 40.0})


class TestReportReconciliationAndNotes(unittest.TestCase):
	def data(self, extra_lines=(), spray=None):
		lines = [line(code="P2", value=100.004, recorded=["Mites"], detail="a"),
		         line(code="P1", value=60.004, detail="b"),
		         line("direct", "P2", 25.004, detail="d", mr="MR-1"), *extra_lines]
		sp = {"in_progress": [], "straddle": [], "not_issued": [], "manufactured": 0, "by_link": {}}
		sp.update(spray or {})
		return {"rows": attr(lines), "lines": lines, "spray": sp, "kinds": KINDS}

	def report(self, data, **kw):
		with mock.patch.object(FP, "ledger_total", side_effect=lambda ls: sum(x["value"] * x.get("share", 1) for x in ls if x["ledger"])):
			return FP.build_report("2026-09-01", "2026-09-30", data=data, **kw)

	def test_reconciles_like_with_like_and_reports_rounding_apart(self):
		r = self.report(self.data())["combined"]
		self.assertTrue(r["reconciles"])
		self.assertEqual(r["total"], r["line_total"])
		self.assertEqual(r["ledger_difference"], 0.0)
		self.assertAlmostEqual(r["rounding_residual"], 0.012, places=2)

	def test_the_flag_is_false_when_the_ledger_disagrees(self):
		d = self.data()
		with mock.patch.object(FP, "ledger_total", return_value=1.0):
			r = FP.build_report("2026-09-01", "2026-09-30", data=d)["combined"]
		self.assertFalse(r["reconciles"])

	def test_straddle_and_not_issued_and_in_progress_follow_the_filters(self):
		sp = {"straddle": [{"work_order": "W1", "value": 70.0, "greenhouse": "GH1", "targets": ["Mites"], "issued": "2026-10-02", "issue": "I"},
		                   {"work_order": "W2", "value": 30.0, "greenhouse": "GH2", "targets": ["Mildew"], "issued": "2026-10-03", "issue": "J"}],
		      "in_progress": [{"work_order": "W3", "value": 5.0, "greenhouse": "GH1", "targets": ["Mites"]}],
		      "not_issued": [{"work_order": "W4", "greenhouse": "GH2", "targets": ["Mildew"]}]}
		r = self.report(self.data(spray=sp))["spray"]
		self.assertEqual((r["straddle"]["plans"], r["straddle"]["value"]), (2, 100.0))
		self.assertIn("booked in the period of the issue", r["straddle"]["note"])
		r = self.report(self.data(spray=sp), greenhouse="GH1")["spray"]
		self.assertEqual((r["straddle"]["value"], r["in_progress"]["plans"], len(r["not_issued"])), (70.0, 1, 0))
		r = self.report(self.data(spray=sp), pests=["Mildew"])["spray"]
		self.assertEqual((r["straddle"]["value"], r["in_progress"]["plans"], len(r["not_issued"])), (30.0, 0, 1))

	def test_effective_paths_echoed_when_a_greenhouse_drops_direct(self):
		r = self.report(self.data(), greenhouse="GH1")
		self.assertEqual(r["filters"]["paths"], ["spray"])
		self.assertEqual(sorted(r["filters"]["requested_paths"]), ["direct", "spray"])
		self.assertNotIn("direct", r)

	def test_returns_net_against_the_product_and_say_how(self):
		ret = line("direct", "P2", -10.0, detail="r", mr="MR-1", is_return=True, netted_against="D1", document="R1")
		d = self.data(extra_lines=[ret])
		r = self.report(d)["direct"]
		self.assertEqual(r["returns"]["total"], -10.0)
		self.assertEqual((r["returns"]["traced"], r["returns"]["untraced"]), (-10.0, 0.0))
		self.assertEqual(r["total"], 15.0)  # 25 issued, 10 returned
		self.assertIn("negative line", r["returns"]["note"])
		untraced = line("direct", "P2", -4.0, detail="r2", is_return=True, netted_against=None, document="R2")
		r = self.report(self.data(extra_lines=[untraced]))["direct"]
		self.assertEqual((r["returns"]["traced"], r["returns"]["untraced"]), (0.0, -4.0))

	def test_zero_ledger_lines_count_as_fallback(self):
		fb = line(code="P2", value=12.0, detail="z", ledger=False)
		self.assertEqual(self.report(self.data(extra_lines=[fb]))["combined"]["fallback_lines"], 1)


class TestPerPathLabels(unittest.TestCase):
	def test_basis_label_is_keyed_by_path_and_basis(self):
		lines = [line(code="P2", value=10, detail="a"), line("direct", "P2", 10, detail="b")]
		refs_ = {"plans": {"P2": [("2026-08-01", "A", ["Mildew"]), ("2026-08-02", "B", ["Mildew"])]}, "mona_ai_t": {},
		         "use_dates": {"P2": [("2026-08-01", "A"), ("2026-08-02", "B")]}}
		rows = FP.attribute(lines, refs_, KB, KINDS, PRODUCTS)
		labels = {(r["path"], r["basis"]): r["credibility_label"] for r in rows}
		self.assertIn("est. 93%", labels[("spray", "band2_alone")])
		self.assertIn("est. 84%", labels[("direct", "band2_alone")])
		from upande_scp.serverscripts.reports import finance_api as API_
		tables = API_._tables(rows, {"from": "a", "to": "b", "paths": ("spray", "direct"), "pests": [], "greenhouse": ""},
		                      {"combined": {"total": 0}, "spray": {"in_progress": {"plans": 0, "value": 0}}}, False)
		mix = [r for r in tables["Summary"] if len(r) == 5 and r[1] == "band2_alone"]
		self.assertEqual({r[0]: r[2] for r in mix}.keys(), {"Spray plan", "Direct issue"})
		self.assertNotEqual(mix[0][2], mix[1][2])
