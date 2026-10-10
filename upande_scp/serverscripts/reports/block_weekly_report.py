"""The weekly block report for block-grown crops — avocado and coffee.

Roses are scouted bed by bed inside greenhouses, and their weekly submission is the
six-sheet KEPHIS FCM workbook: a regulated template, specific to false codling moth.
Avocado and coffee are grown on **blocks**, are not FCM-reportable, and need something
much plainer — one sheet, blocks down the rows, pests across the columns, and the
week's counts in the cells.

## What a cell holds

`SUM(count)` from `Pests Scouting Entry` for that pest, in that block, over the ISO
week. The child row records `plant_section`, `pest`, `stage` and `count`; summing count
is the literal "cumulative over that week" and stays comparable between blocks of
similar size. Stage and plant section are summed over rather than broken out — a
sheet with a column per (pest, stage, section) is unreadable at avocado's pest count. Shading comes from
`thresholds_check.figures_for_houses`, the alerts' own figure.

Pests only. Diseases, weeds, predators and disorders are recorded by the same scouts on
the same entries, but this sheet answers one question.

## Why a block with no data still gets a row

A block that was walked and found clean and a block nobody visited are different facts,
and a sheet that omits both makes them identical. Every block on the farm gets a row;
an unvisited one is visibly all-zero rather than absent.

## Why a farm with no blocks is refused rather than emptied

Coffee is tagged to Endebess and Saboti, and neither has a single warehouse typed as a
`Block` — 96 and 23 warehouses between them, all untyped. A report for those farms is
not empty because nothing was found; it is empty because there is nothing to look at.
`availability()` says so, and the page refuses the download rather than handing over a
file whose blankness means something different from what it looks like.
"""

from __future__ import annotations

import io
from collections import defaultdict

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.scouting import thresholds_check
from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _week_bounds

#: Warehouses of this type are the reporting unit for block-grown crops.
BLOCK_TYPE = "Block"


def _blocks_for_farm(farm: str) -> list[str]:
	rows = frappe.get_all(
		"Warehouse",
		filters={
			"custom_farm": farm,
			"warehouse_type": BLOCK_TYPE,
			"disabled": 0,
			"is_group": 0,
		},
		fields=["name"],
		order_by="name",
	)
	return [r["name"] for r in rows]


@frappe.whitelist()
def availability(crop: str) -> dict:
	"""Which of this crop's farms can produce a report, and why the others cannot.

	Returned before any download so the page can explain a farm with no blocks rather
	than offer a file that looks empty for the wrong reason.
	"""
	if not crop:
		frappe.throw("A crop is required.")

	farms = crop_scope.scoped_farms(crop, frappe.session.user)
	if farms is None:
		farms = crop_scope.farms_for_crop(crop) or set()

	ready, blocked = [], []
	for farm in sorted(farms):
		blocks = _blocks_for_farm(farm)
		if blocks:
			ready.append({"farm": farm, "blocks": len(blocks)})
		else:
			blocked.append({
				"farm": farm,
				"reason": (
					f"{farm} has no blocks set up yet — its warehouses are not typed as "
					f"'{BLOCK_TYPE}', so there is nothing to report on."
				),
			})

	return {"crop": crop, "ready": ready, "blocked": blocked}


@frappe.whitelist()
def report_weeks(crop: str, farm: str, limit: int = 26) -> list[dict]:
	"""ISO weeks that actually have scouting on this farm, newest first.

	Offered instead of a free week picker so nobody downloads a blank sheet for a week
	nobody walked — the same reason `availability` exists one level up.
	"""
	blocks = _blocks_for_farm(farm)
	if not blocks:
		return []
	rows = frappe.db.sql(
		"""
		SELECT YEAR(se.date_of_capture) AS iso_year,
		       WEEK(se.date_of_capture, 3) AS iso_week,
		       COUNT(*) AS entries
		FROM `tabScouting Entry` se
		WHERE se.block IN %(blocks)s AND se.crop_scouted = %(crop)s
		  AND se.date_of_capture IS NOT NULL
		GROUP BY iso_year, iso_week
		ORDER BY iso_year DESC, iso_week DESC
		LIMIT %(limit)s
		""",
		{"blocks": tuple(blocks), "crop": crop, "limit": int(limit)},
		as_dict=True,
	)
	out = []
	for r in rows:
		monday, sunday = _week_bounds(int(r["iso_year"]), int(r["iso_week"]))
		out.append({
			"year": int(r["iso_year"]),
			"week": int(r["iso_week"]),
			"entries": int(r["entries"]),
			"label": f"W{int(r['iso_week']):02d} · {monday} to {sunday}",
		})
	return out


def _pest_counts(blocks: list[str], monday, sunday, crop: str) -> dict:
	"""``{block: {pest: total}}`` for one ISO week.

	One query rather than one per block: a farm can carry a hundred blocks, and this
	runs behind a download the user is waiting on.
	"""
	if not blocks:
		return {}
	# `block`, not `greenhouse`. A block-grown crop records its unit in `Scouting
	# Entry.block`; `greenhouse` is NULL on every one of the 3,362 avocado entries.
	# Joining on the wrong one returns an empty sheet that looks like a clean week.
	rows = frappe.db.sql(
		"""
		SELECT se.block AS block, p.pest AS pest, SUM(p.count) AS total
		FROM `tabPests Scouting Entry` p
		JOIN `tabScouting Entry` se ON se.name = p.parent
		WHERE se.block IN %(blocks)s
		  AND se.crop_scouted = %(crop)s
		  AND se.date_of_capture BETWEEN %(monday)s AND %(sunday)s
		  AND p.pest IS NOT NULL AND p.pest != ''
		GROUP BY se.block, p.pest
		""",
		{
			"blocks": tuple(blocks),
			"crop": crop,
			"monday": monday,
			"sunday": sunday,
		},
		as_dict=True,
	)
	out: dict = defaultdict(dict)
	for r in rows:
		out[r["block"]][r["pest"]] = float(r["total"] or 0)
	return out


def _pests_for_crop(crop: str) -> list[str]:
	"""Every pest this crop's filters name, so the columns are stable week to week.

	Taken from the crop's `Pest Filter` records rather than from the week's data: a
	pest that was not seen this week still deserves a column, or the sheet's shape
	changes every week and cannot be compared or pivoted.
	"""
	rows = frappe.get_all(
		"Pest Filter", filters={"crop_scouted": crop}, fields=["pest"], order_by="pest"
	)
	pests = []
	for r in rows:
		if r.get("pest") and r["pest"] not in pests:
			pests.append(r["pest"])
	return pests


def _thresholds_for_crop(crop: str) -> dict:
	"""{pest: {"measure", "low", "moderate", "high"}} — the crop's row bands, for
	the legend. Read through `_common.load_thresholds`, so the legend lists exactly
	the bands the shading (and the dashboards and alerts) judged with: a pest with
	no bands, or misordered ones, is absent (thresholds spec D3)."""
	out = {}
	for (kind, obs, stage), spec in _common.load_thresholds(crop).items():
		if kind != "pest" or stage or not obs:
			continue
		out[obs] = {
			"measure": spec["measure"],
			"low": spec["low"],
			"moderate": spec["mod"],
			"high": spec["high"],
		}
	return out


def _block_areas(blocks: list[str]) -> dict:
	"""{block: hectares} from `Warehouse.custom_area_ha`.

	This is the denominator for a Per-Hectare threshold, and it is the reason
	the report can say anything at all about pressure: a count of 40 is a
	different fact on a 1.5 ha block and on a 12 ha one. `get_units_by_warehouse`
	has surfaced the same figure for the dashboards all along.

	A block with no area is returned absent rather than as zero — see
	`_per_hectare`. On Lokitela all 78 blocks carry one (213.27 ha); Endebess's 64
	coffee blocks carry none, which is a setup gap and has to read as one.
	"""
	if not blocks:
		return {}
	rows = frappe.get_all(
		"Warehouse",
		filters={"name": ["in", blocks]},
		fields=["name", "custom_area_ha"],
		limit_page_length=0,
	)
	return {
		r["name"]: float(r["custom_area_ha"])
		for r in rows
		if float(r.get("custom_area_ha") or 0) > 0
	}


def _per_hectare(total: float, area_ha: float | None):
	"""The week's count over the block's hectares, or None without an area —
	dividing by a missing denominator would invent a figure (Endebess's coffee
	blocks carry none). Kept as a column, not a band (thresholds D8)."""
	if not area_ha:
		return None
	return round(float(total or 0) / float(area_ha), 2)


def build_workbook_bytes(crop: str, farm: str, iso_year: int, iso_week: int) -> bytes:
	from openpyxl import Workbook
	from openpyxl.styles import Alignment, Font, PatternFill

	blocks = _blocks_for_farm(farm)
	if not blocks:
		frappe.throw(
			f"{farm} has no blocks set up, so there is nothing to report on.",
			frappe.ValidationError,
		)

	monday, sunday = _week_bounds(iso_year, iso_week)
	counts = _pest_counts(blocks, monday, sunday, crop)

	thresholds = _thresholds_for_crop(crop)
	areas = _block_areas(blocks)
	figs = thresholds_check.figures_for_houses(crop, blocks, str(monday), str(sunday))
	station = _common.station_word(crop)

	pests = _pests_for_crop(crop)
	# A pest seen this week but absent from the crop's filters still gets a column —
	# the data is the authority on what was found, the filters only on what to expect.
	for block_counts in counts.values():
		for pest in block_counts:
			if pest not in pests:
				pests.append(pest)

	wb = Workbook()
	ws = wb.active
	ws.title = f"{crop} W{iso_week:02d}"

	ws["A1"] = f"{crop} — weekly pest counts"
	ws["A1"].font = Font(bold=True, size=14)
	ws["A2"] = f"{farm}   ·   {iso_year}-W{iso_week:02d}   ·   {monday} to {sunday}"
	ws["A3"] = "Each cell is the total count recorded for that pest on that block over the week."
	ws["A4"] = (
		"Shading is the severity band from the crop's thresholds, judged on the same "
		"figure as the dashboards and alerts: the share of scouted trees carrying the "
		"pest (Percentage) or the average count per scouted tree (Count), over the "
		"block's 3 \u00d7 3 sections. Reports judge on the row bands only. Count / ha "
		"is the week's total over the block's area; a block with no area shows \u2014."
	)
	ws["A4"].font = Font(italic=True, size=9, color="666666")

	# Area sits beside the block, because it is the denominator every shaded
	# cell on that row was judged against — a reader who cannot see it cannot
	# check the colour.
	header_row = 6
	first_pest_col = 4
	ws.cell(row=header_row, column=1, value="Block")
	ws.cell(row=header_row, column=2, value="Area (ha)")
	ws.cell(row=header_row, column=3, value="Count / ha")
	for i, pest in enumerate(pests):
		ws.cell(row=header_row, column=first_pest_col + i, value=pest)
	ws.cell(row=header_row, column=first_pest_col + len(pests), value="Total")

	head_fill = PatternFill("solid", fgColor="DDDDDD")
	for c in range(1, first_pest_col + len(pests) + 1):
		cell = ws.cell(row=header_row, column=c)
		cell.font = Font(bold=True)
		cell.fill = head_fill
		cell.alignment = Alignment(horizontal="center", wrap_text=True)

	# One hue, three depths. Severity is a single thing getting worse, and a
	# ramp within one colour reads that way at a glance; amber-to-red reads as
	# three separate states that have to be learned from the legend. All three
	# stay light enough for black text to sit on them, and they are far enough
	# apart in value to survive a greyscale print — which is how these sheets
	# are read in a packhouse.
	band_fills = {
		"low": PatternFill("solid", fgColor="FDE8E8"),
		"moderate": PatternFill("solid", fgColor="F7B9B9"),
		"high": PatternFill("solid", fgColor="E98080"),
	}

	column_totals = [0.0] * len(pests)
	for r, block in enumerate(blocks, start=header_row + 1):
		ws.cell(row=r, column=1, value=block)
		area = areas.get(block)
		area_cell = ws.cell(row=r, column=2, value=area if area else "\u2014")
		if not area:
			area_cell.alignment = Alignment(horizontal="center")
		row_total = 0.0
		for i, pest in enumerate(pests):
			value = counts.get(block, {}).get(pest, 0)
			cell = ws.cell(row=r, column=first_pest_col + i, value=value)
			band = (figs.get(block, {}).get(pest) or {}).get("band")
			if value and band:
				cell.fill = band_fills[band]
			row_total += value
			column_totals[i] += value
		ws.cell(row=r, column=first_pest_col + len(pests), value=row_total)
		per_ha = _per_hectare(row_total, area)
		per_ha_cell = ws.cell(row=r, column=3, value=per_ha if per_ha is not None else "\u2014")
		if per_ha is None:
			per_ha_cell.alignment = Alignment(horizontal="center")

	total_row = header_row + 1 + len(blocks)
	ws.cell(row=total_row, column=1, value="Total").font = Font(bold=True)
	total_area = sum(areas.get(b, 0) for b in blocks)
	if total_area:
		ws.cell(row=total_row, column=2, value=round(total_area, 2)).font = Font(bold=True)
		ws.cell(row=total_row, column=3, value=_per_hectare(sum(column_totals), total_area)).font = Font(bold=True)
	for i, total in enumerate(column_totals):
		cell = ws.cell(row=total_row, column=first_pest_col + i, value=total)
		cell.font = Font(bold=True)
	grand = ws.cell(row=total_row, column=first_pest_col + len(pests), value=sum(column_totals))
	grand.font = Font(bold=True)

	# The legend carries the actual numbers, not just the colours — a band name
	# with no figure behind it cannot be checked or argued with.
	legend_row = total_row + 2
	ws.cell(row=legend_row, column=1, value="Thresholds").font = Font(bold=True)
	if thresholds:
		ws.cell(row=legend_row, column=2, value="Measure")
		ws.cell(row=legend_row, column=3, value="Low")
		ws.cell(row=legend_row, column=4, value="Moderate")
		ws.cell(row=legend_row, column=5, value="High")
		for c in range(2, 6):
			ws.cell(row=legend_row, column=c).font = Font(bold=True)
		for n, pest in enumerate(sorted(thresholds), start=1):
			spec = thresholds[pest]
			ws.cell(row=legend_row + n, column=1, value=pest)
			ws.cell(row=legend_row + n, column=2, value=f"{spec['measure']} ({B.unit_label(spec['measure'], station)})")
			for col, key in ((3, "low"), (4, "moderate"), (5, "high")):
				cell = ws.cell(row=legend_row + n, column=col, value=spec[key] or None)
				cell.fill = band_fills[key]
	else:
		ws.cell(
			row=legend_row + 1,
			column=1,
			value=f"No thresholds are set on {crop}'s Pest Filters, so nothing is shaded.",
		).font = Font(italic=True, color="666666")

	missing_area = [b for b in blocks if not areas.get(b)]
	if missing_area:
		note_row = legend_row + len(thresholds) + 2
		ws.cell(
			row=note_row,
			column=1,
			value=(
				f"{len(missing_area)} of {len(blocks)} blocks have no area set, so their "
				"count per hectare cannot be shown. Set Area (ha) on the "
				"block's Warehouse to bring them in."
			),
		).font = Font(italic=True, color="996600")

	ws.column_dimensions["A"].width = 32
	ws.column_dimensions["B"].width = 10
	ws.column_dimensions["C"].width = 11
	for i in range(len(pests) + 1):
		ws.column_dimensions[
			ws.cell(row=header_row, column=first_pest_col + i).column_letter
		].width = 14
	ws.freeze_panes = ws.cell(row=header_row + 1, column=first_pest_col)

	buf = io.BytesIO()
	wb.save(buf)
	return buf.getvalue()


@frappe.whitelist()
def download_block_weekly_xlsx(crop: str, farm: str, week=None, year=None):
	from datetime import date

	crop_scope.assert_crop(crop)
	allowed = crop_scope.scoped_farms(crop, frappe.session.user)
	if allowed is not None and farm not in allowed:
		frappe.throw(
			f"{farm} is not a farm you have access to for {crop}.",
			frappe.PermissionError,
		)

	today = date.today()
	iso_year = int(year) if year else today.isocalendar()[0]
	iso_week = int(week) if week else today.isocalendar()[1]

	data = build_workbook_bytes(crop, farm, iso_year, iso_week)
	safe_farm = str(farm).replace(" ", "_").replace("/", "-")
	frappe.local.response.filename = (
		f"{crop}_{safe_farm}_{iso_year}-W{iso_week:02d}.xlsx"
	)
	frappe.local.response.filecontent = data
	frappe.local.response.type = "binary"
