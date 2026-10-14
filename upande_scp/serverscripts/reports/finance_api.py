"""Endpoints for the pest-attribution finance report and its Excel export.

The Excel file is built in memory with openpyxl in WRITE-ONLY mode. Only the header
rows are styled; values are rounded to 2 dp and written plain. Per-cell styling was
measured as the main cause of a slow export elsewhere (91% of 22.7 s), so no cell on
a data row is ever styled.
"""

from __future__ import annotations

import io
import json
from collections import defaultdict

import frappe
from frappe.utils import flt, getdate

from upande_scp.serverscripts.reports import finance_attribution as FAT
from upande_scp.serverscripts.reports import finance_paths as FP
from upande_scp.serverscripts.reports.finances import _ensure_finance_role

PATH_LABEL = {"spray": "Spray plan", "direct": "Direct issue"}
FOLIAR_COL = "Foliar (equal split)"


def _list(v):
	if isinstance(v, str):
		v = v.strip()
		if not v:
			return []
		try:
			v = json.loads(v)
		except ValueError:
			v = [x for x in v.split(",") if x]
	return [x for x in (v or []) if x]


def _paths(path) -> tuple:
	p = (path or "both").lower()
	if p in ("spray", "spray plan"):
		return ("spray",)
	if p in ("direct", "direct issue"):
		return ("direct",)
	return FP.PATHS


@frappe.whitelist()
def pest_attribution_report(from_date, to_date, path="both", pests=None, greenhouse=None) -> dict:
	_ensure_finance_role()
	return FP.build_report(getdate(from_date), getdate(to_date), _paths(path), _list(pests), greenhouse or None)


# --- Workbook --------------------------------------------------------------------------------


def _split_value(r) -> tuple:
	"""(recorded, derived, foliar) parts of a row's attributed value."""
	v = round(flt(r["attributed"]), 2)
	if r["target"] == FP.UNATTRIBUTED and not r["is_foliar"]:
		return 0.0, 0.0, 0.0
	if r["is_foliar"]:
		return 0.0, 0.0, v
	if r["credibility"] == "recorded":
		return v, 0.0, 0.0
	return 0.0, v, 0.0


def _tables(rows, filters, report, per_product):
	"""The data of every sheet, as header + row lists (kept apart from openpyxl so it is testable)."""
	sheets = {}

	# --- Summary
	summ = [["Crop-protection spend by pest and disease"], []]
	summ += [["Filters"],
	         ["From", filters["from"]], ["To", filters["to"]],
	         ["Path", " + ".join(PATH_LABEL[p] for p in filters["paths"])],
	         ["Pests", ", ".join(filters["pests"]) or "All"],
	         ["Greenhouse", filters["greenhouse"] or "All"],
	         ["Breakdown per product", "Yes" if per_product else "No"], []]
	by_path = defaultdict(lambda: defaultdict(float))
	acc_w = defaultdict(float)
	acc_v = defaultdict(float)
	for r in rows:
		rec, der, fol = _split_value(r)
		d = by_path[r["path"]]
		d["rec"] += rec
		d["der"] += der
		if r["is_foliar"]:
			d["fol_t" if r["basis"] == "foliar_equal" else "fol_f"] += fol
		elif r["target"] == FP.UNATTRIBUTED:
			d["unat"] += r["attributed"]
		if der and r["accuracy"] is not None:
			acc_w[r["path"]] += der * r["accuracy"]
			acc_v[r["path"]] += der
	summ.append(["Totals by path"])
	hdr_totals = ["Path", "Chemical — Recorded", "Chemical — Derived", "Derived est. accuracy",
	              "Chemical — Unattributed", FOLIAR_COL, "Foliar — not target-specific", "Total"]
	summ.append(hdr_totals)
	grand = 0.0
	for p in filters["paths"]:
		d = by_path[p]
		total = d["rec"] + d["der"] + d["unat"] + d["fol_t"] + d["fol_f"]
		grand += total
		summ.append([PATH_LABEL[p], round(d["rec"], 2), round(d["der"], 2),
		             round(acc_w[p] / acc_v[p], 4) if acc_v[p] else None, round(d["unat"], 2),
		             round(d["fol_t"], 2), round(d["fol_f"], 2), round(total, 2)])
	summ.append(["Total", None, None, None, None, None, None, round(grand, 2)])
	summ.append([])
	summ.append(["Totals by path and pest (chemicals only)"])
	summ.append(["Path", "Pest / disease", "Recorded", "Derived", "Total", "Credibility"])
	pp = defaultdict(lambda: [0.0, 0.0, set()])
	for r in rows:
		if r["is_foliar"] or r["target"] == FP.UNATTRIBUTED:
			continue
		rec, der, _ = _split_value(r)
		e = pp[(r["path"], r["target"])]
		e[0] += rec
		e[1] += der
		e[2].add(r["credibility_label"])
	for (p, t), (rec, der, labels) in sorted(pp.items(), key=lambda kv: (kv[0][0], -(kv[1][0] + kv[1][1]))):
		summ.append([PATH_LABEL[p], t, round(rec, 2), round(der, 2), round(rec + der, 2), "; ".join(sorted(labels))])
	summ.append([])
	summ.append(["Basis mix"])
	summ.append(["Path", "Basis", "Credibility", "Spend", "Share of path"])
	bm = defaultdict(float)
	pt = defaultdict(float)
	lab = {}
	for r in rows:
		bm[(r["path"], r["basis"])] += r["attributed"]
		pt[r["path"]] += r["attributed"]
		lab[r["basis"]] = r["credibility_label"]
	for (p, b), v in sorted(bm.items()):
		summ.append([PATH_LABEL[p], b, lab[b], round(v, 2), round(v / pt[p], 4) if pt[p] else None])
	summ.append([])
	c = report["combined"]
	ip = (report.get("spray") or {}).get("in_progress")
	summ.append(["Reconciliation"])
	summ.append(["Report total", c["total"]])
	if c.get("line_total") is not None:
		summ.append(["Source lines total", c["line_total"]])
		summ.append(["Stock Ledger total", c["ledger_total"]])
		summ.append(["Difference to ledger", c["ledger_difference"]])
	if ip:
		summ.append(["Not counted: plans in progress / not issued", f'{ip["plans"]} plans, value {ip["value"]}'])
	sheets["Summary"] = summ

	# --- By greenhouse
	gh = defaultdict(lambda: [0.0, 0.0, 0.0])
	for r in rows:
		key = (r["path"], r["farm"] or "", FP.FARM_LEVEL if r["path"] == "direct" else r["greenhouse"],
		       r["cost_center"] or "", r["target"])
		rec, der, fol = _split_value(r)
		e = gh[key]
		e[0] += rec
		e[1] += der
		e[2] += fol
	g = [["Path", "Farm", "Greenhouse", "Cost centre", "Pest / disease", "Recorded", "Derived", FOLIAR_COL, "Total"]]
	for key in sorted(gh, key=lambda k: (k[0], k[2] or "", k[4])):
		rec, der, fol = gh[key]
		g.append([PATH_LABEL[key[0]], key[1], key[2], key[3], key[4], round(rec, 2), round(der, 2), round(fol, 2),
		          round(rec + der + fol, 2)])
	sheets["By greenhouse"] = g

	# --- By product
	if per_product:
		pr = defaultdict(lambda: [0.0, 0.0, 0.0, set()])
		for r in rows:
			e = pr[(r["path"], r["item_name"], r["item_code"], r["target"])]
			rec, der, fol = _split_value(r)
			e[0] += rec
			e[1] += der
			e[2] += fol
			e[3].add(r["credibility_label"])
		pl = [["Path", "Product", "Item code", "Pest / disease", "Recorded", "Derived", FOLIAR_COL, "Total", "Credibility"]]
		for (p, name, code, t), (rec, der, fol, labels) in sorted(pr.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][3])):
			pl.append([PATH_LABEL[p], name, code, t, round(rec, 2), round(der, 2), round(fol, 2),
			           round(rec + der + fol, 2), "; ".join(sorted(labels))])
		sheets["By product"] = pl

	# --- Lines (audit)
	ln = [["Date", "Document", "Path", "Work order", "Material request", "Greenhouse", "Farm", "Cost centre",
	       "Item code", "Product", "Qty", "UoM", "Line value", "Pest / disease", "Share", "Basis", "Credibility",
	       "Est. accuracy", "Recorded value", "Derived value", FOLIAR_COL, "Unattributed value", "Attributed value"]]
	for r in rows:
		rec, der, fol = _split_value(r)
		ln.append([r["date"], r["document"], PATH_LABEL[r["path"]], r["work_order"] or "", r["mr"] or "",
		           r["greenhouse"] or (FP.FARM_LEVEL if r["path"] == "direct" else ""), r["farm"] or "",
		           r["cost_center"] or "", r["item_code"], r["item_name"], round(flt(r["qty"]), 4), r["uom"],
		           round(flt(r["value"]), 2), r["target"], round(r["share"], 6), r["basis"], r["credibility_label"],
		           r["accuracy"], rec, der, fol,
		           round(flt(r["attributed"]), 2) if r["target"] == FP.UNATTRIBUTED and not r["is_foliar"] else 0.0,
		           round(flt(r["attributed"]), 2)])
	sheets["Lines"] = ln
	return sheets


def build_workbook(from_date, to_date, paths=FP.PATHS, pests=None, greenhouse=None, per_product=False) -> tuple:
	"""Returns (xlsx bytes, sheets dict). Rows come from the same attribution as the report."""
	from openpyxl import Workbook
	from openpyxl.cell import WriteOnlyCell
	from openpyxl.styles import Alignment, Font, PatternFill

	data = FP.collect_rows(getdate(from_date), getdate(to_date))
	rows, _notes = FP.apply_filters(data["rows"], paths=paths, pests=pests, greenhouse=greenhouse)
	report = FP.build_report(getdate(from_date), getdate(to_date), paths, pests, greenhouse, data=data)
	filters = report["filters"]
	sheets = _tables(rows, filters, report, per_product)

	wb = Workbook(write_only=True)
	head_font = Font(bold=True, color="FFFFFF")
	head_fill = PatternFill("solid", fgColor="1F3A2E")
	wrap = Alignment(wrap_text=True, vertical="center")

	def head(ws, values):
		cells = []
		for v in values:
			c = WriteOnlyCell(ws, value=v)
			c.font, c.fill, c.alignment = head_font, head_fill, wrap
			cells.append(c)
		ws.append(cells)

	header_rows = {
		"Summary": {"Totals by path", "Totals by path and pest (chemicals only)", "Basis mix", "Reconciliation", "Filters"},
	}
	for name, table in sheets.items():
		ws = wb.create_sheet(name)
		width = max((len(r) for r in table), default=1)
		for i in range(width):
			ws.column_dimensions[chr(65 + i) if i < 26 else "A" + chr(65 + i - 26)].width = 20 if name != "Lines" else 16
		if name == "Summary":
			ws.column_dimensions["A"].width = 34
			for row in table:
				# Table header rows (the line after a section title) are the only styled cells.
				if len(row) > 3 and all(isinstance(x, str) for x in row if x is not None) and row[0] in ("Path",):
					head(ws, row)
				else:
					ws.append(row)
		else:
			ws.freeze_panes = "A2"
			head(ws, table[0])
			for row in table[1:]:
				ws.append(row)
	buf = io.BytesIO()
	wb.save(buf)
	return buf.getvalue(), sheets


@frappe.whitelist()
def export_pest_attribution(from_date, to_date, path="both", pests=None, greenhouse=None, per_product=0):
	"""Download the report as an .xlsx with the same filters as the page."""
	_ensure_finance_role()
	content, _ = build_workbook(
		getdate(from_date), getdate(to_date), _paths(path), _list(pests), greenhouse or None,
		bool(int(per_product or 0)),
	)
	frappe.response["filename"] = f"pest_attribution_{from_date}_{to_date}.xlsx"
	frappe.response["filecontent"] = content
	frappe.response["type"] = "binary"
