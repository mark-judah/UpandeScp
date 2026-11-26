"""Spray ticket (MOLFM27 layout) for one Application Floor Plan Work Order.

Nothing here is stored. ``gather`` reads the plan's existing records (Work Order,
block warehouse tree, Production Crop Cycle, Spray Product rates and ingredients,
and the sign-offs ``lifecycle.get_lifecycle`` already derives) and ``build_ticket``
folds them into ticket lines and a percent complete. A ticket prints only at 100%.
"""
from __future__ import annotations

import math

import frappe
from frappe.utils import flt, getdate

STAGE_HINT = "Set the crop stage on the crop cycle in Production"

# (key, label, group, hint when missing). Order is the ticket order.
LINES = [
	("block", "Block", "details", "Pick a block on the plan"),
	("farm", "Farm", "details", "Set the farm on the block warehouse"),
	("location", "Location", "details", "The block has no Phase/Section above it"),
	("area_ha", "Area (ha)", "details", "Set the area on the plan"),
	("crop", "Crop", "details", "No crop resolves for this block"),
	("variety", "Variety", "details", "Set the variety on the crop cycle in Production"),
	("crop_stage", "Crop stage", "details", STAGE_HINT),
	("app_week", "Application week", "details", "Schedule the plan"),
	("operator", "Operator", "details", "Assign the spray team on the plan"),
	("products", "Products and rates", "details", "Add chemicals with a rate to the plan"),
	("composition", "Composition", "details", "Add active ingredients to each product"),
	("equipment", "Equipment", "details", "Pick a kit on the plan"),
	("method", "Method of application", "details", "Pick a method on the plan"),
	("water", "Water and dilution", "details", "Set the water volume on the plan"),
	("prepared", "Prepared by", "signoff", "Written when the plan is created"),
	("authorized", "Technical authorization", "signoff", "Awaiting approval"),
	("issued", "Issued by (stores)", "signoff", "Awaiting the stores transfer"),
	("collected", "Collected by", "signoff", "Awaiting the supervisor's scan"),
	("applied", "Date of application", "signoff", "Awaiting the spray session"),
	("targets", "Targets", "spray", None),
	("classification", "Classification", "spray", None),
	("reentry", "Re-entry", "spray", None),
	("phi", "Pre-harvest interval", "spray", None),
]

# sign-off line -> lifecycle step that fills it
SIGNOFF_STEP = {
	"prepared": "created",
	"authorized": "approved",
	"issued": "chemical_issued",
	"collected": "labels_scanned",
	"applied": "completed",
}


def _text(v):
	if v is None:
		return None
	v = str(v).strip()
	return v or None


def _stamp(step: dict) -> str:
	bits = [b for b in (step.get("actor"), str(step.get("timestamp") or "").replace("T", " ")[:16]) if b]
	return " · ".join(bits) or "Done"


def _step(ctx, key):
	return next((s for s in ctx.get("steps") or [] if s.get("key") == key), None)


def _products_line(ctx):
	prods = ctx.get("products") or []
	if not prods:
		return None, "Add chemicals with a rate to the plan"
	rows, bad = [], []
	for p in prods:
		qty = f"{flt(p.get('qty')):g} {p.get('uom') or ''}".strip()
		if p.get("rate"):
			rows.append(f"{_label(p)}: {qty} ({p['rate']})")
		else:
			rows.append(f"{_label(p)}: {qty}")
			bad.append(p.get("reason") or f"No rate for {_label(p)}")
	return "\n".join(rows), ("; ".join(bad) if bad else None)


def _composition_line(ctx):
	prods = ctx.get("products") or []
	if not prods:
		return None, "Add chemicals to the plan"
	rows, bad = [], []
	for p in prods:
		ing = [i for i in (p.get("ingredients") or []) if i]
		if ing:
			rows.append(f"{_label(p)}: {', '.join(ing)}")
		else:
			bad.append(_label(p))
	return ("\n".join(rows) or None), (
		"No active ingredients on " + ", ".join(bad) if bad else None
	)


def _water_line(ctx):
	water = flt(ctx.get("water_l"))
	if water <= 0:
		if not ctx.get("water_required", True):
			return "Not applicable: dosed per area", None
		return None, "Set the water volume on the plan"
	bits = [f"{water:g} L"]
	bits += [f"{_label(p)}: {p['per_litre']}" for p in ctx.get("products") or [] if p.get("per_litre")]
	return "\n".join(bits), None


def _label(p: dict) -> str:
	"""A product as people know it: its item name, the code only when there is no name."""
	return p.get("item_name") or p["item_code"]


def build_ticket(ctx: dict) -> dict:
	"""Pure: fold a gathered context into ``{percent, printable, missing, lines}``."""
	special = {
		"products": _products_line(ctx),
		"composition": _composition_line(ctx),
		"water": _water_line(ctx),
	}
	spray = ctx.get("spray") or {}
	lines, counted, filled_n, missing = [], 0, 0, []
	for key, label, group, hint in LINES:
		value, why = None, None
		if key in special:
			value, why = special[key]
			filled = bool(value) and not why
		elif key in SIGNOFF_STEP:
			step = _step(ctx, SIGNOFF_STEP[key])
			filled = bool(step and step.get("status") == "done")
			if filled:
				value = _stamp(step)
				if key == "applied":
					start = _step(ctx, "spraying_started") or {}
					value = (
						f"{str(start.get('timestamp') or '').replace('T', ' ')[:16]} → "
						f"{str(step.get('timestamp') or '').replace('T', ' ')[:16]}"
					)
		elif group == "spray":
			value = _text(spray.get(key))
			filled = value is not None
		else:
			v = ctx.get(key)
			value = _text(f"{flt(v):g}" if key == "area_ha" and v else v)
			filled = value is not None
		if group != "spray":
			counted += 1
			if filled:
				filled_n += 1
			else:
				missing.append(label)
		lines.append({
			"key": key, "label": label, "group": group, "value": value,
			"filled": filled, "hint": None if filled else (why or hint),
		})
	percent = math.floor(100 * filled_n / counted)
	return {
		"work_order": ctx.get("work_order"),
		"percent": percent,
		"printable": percent == 100 and not ctx.get("stopped"),
		"stopped": bool(ctx.get("stopped")),
		"missing": missing,
		"lines": lines,
		"products": ctx.get("products") or [],
	}


# ───────────────────────────────── gathering ─────────────────────────────────


def _pick_cycle(cycles: list, on_date):
	"""Live cycle covering ``on_date`` with the latest start (as ``planting.pick_cycle_item``)."""
	from ..common.planting import LIVE_STATUSES

	on_date = getdate(on_date)
	best = None
	for c in cycles or []:
		if c.get("status") not in LIVE_STATUSES or not c.get("start_date"):
			continue
		if getdate(c["start_date"]) > on_date:
			continue
		if best is None or getdate(c["start_date"]) > getdate(best["start_date"]):
			best = c
	return best


def _live_cycle(unit: str | None, on_date):
	from ..common import planting

	if not unit or not planting.production_available():
		return None
	cycles = frappe.get_all(
		"Production Crop Cycle",
		filters={"unit": unit},
		fields=["name", "status", "start_date", "current_stage", "variety", "item"],
		limit_page_length=0,
	)
	return _pick_cycle(cycles, on_date)


def _operator(wo) -> str | None:
	rows = list(wo.get("custom_spray_plan_team_members") or [])
	if rows:
		rows.sort(key=lambda r: 0 if "supervisor" in (r.role or "").lower() else 1)
		return ", ".join(
			f"{r.employee_name or r.employee}" + (f" ({r.role})" if r.role else "") for r in rows
		)
	return _text(wo.get("custom_spray_team"))


def _products(wo, crop, area_ha, water_l, prefer_area):
	from ..common import spray_rates

	out = []
	for it in wo.get("required_items") or []:
		code = it.item_code
		qty = flt(it.required_qty)
		stock_uom = frappe.db.get_value("Item", code, "stock_uom") or ""
		row = spray_rates.pick_row(spray_rates.rates_for(code, crop), prefer_area)
		rate, reason = None, None
		if not row:
			reason = f"No rate set for {code}"
		else:
			value = spray_rates.rate_from_quantity(
				qty, row, flt(area_ha) * 10000 if area_ha else None, water_l or None
			)
			if value is None:
				reason = f"{code}: the plan has no {'area' if row['basis'] != 'Water' else 'water volume'} to work the rate out"
			else:
				rate = f"{round(value, 3):g} {row['stock_uom'] or stock_uom} per {row['per_qty']:g} {row['per_uom']}"
		ingredients = []
		if frappe.db.exists("Spray Product", code):
			for ai in frappe.get_all(
				"Active Ingredient",
				filters={"parent": code, "parenttype": "Spray Product"},
				fields=["active_ingredient", "ingredient", "concentration", "concentration_unit"],
				order_by="idx asc",
			):
				name = ai.active_ingredient or ai.ingredient
				if name:
					conc = f" {ai.concentration:g} {ai.concentration_unit or ''}".rstrip() if ai.concentration else ""
					ingredients.append(f"{name}{conc}")
		out.append({
			"item_code": code, "item_name": it.item_name or code, "qty": qty, "uom": stock_uom, "rate": rate, "reason": reason,
			"ingredients": ingredients,
			"per_litre": f"{qty / water_l:.4g} {stock_uom} per litre" if water_l else None,
		})
	return out


def gather(work_order: str) -> dict:
	"""Read-only: the context ``build_ticket`` folds. Access and greenhouse scope come
	from ``lifecycle.get_lifecycle`` and are checked before anything else is read."""
	from ..common import planting
	from ..spray_plan_creator import lifecycle, open_field

	life = lifecycle.get_lifecycle(work_order)
	wo = frappe.get_doc("Work Order", work_order)
	block = wo.custom_greenhouse
	when = wo.custom_scheduled_application_time or wo.planned_start_date
	on_date = getdate(when) if when else getdate()

	tree = open_field._ancestors([block]) if block else {}
	unit = None
	farm = None
	if block:
		meta = frappe.get_meta("Warehouse")
		if meta.has_field("custom_production_unit"):
			unit = frappe.db.get_value("Warehouse", block, "custom_production_unit")
		if meta.has_field("custom_farm"):
			farm = frappe.db.get_value("Warehouse", block, "custom_farm")
	kind, group = open_field.group_of(block, tree) if block else (None, None)
	parent = (tree.get(block) or {}).get("parent_warehouse")
	location = open_field._short(group or parent) if (group or parent) else None

	cycle = _live_cycle(unit, on_date)
	crop = planting.crop_for_station(block, on_date) if block else None
	area_ha = flt(wo.custom_area) or None
	water_l = flt(wo.custom_water_volume) or None
	is_block = bool(block) and (tree.get(block) or {}).get("warehouse_type") == "Block"
	products = _products(wo, crop, area_ha, water_l, is_block)

	week = None
	if when:
		iso = getdate(when).isocalendar()
		week = f"W{iso[1]:02d} {iso[0]}"

	water_required = True
	if is_block and not water_l:
		from ..common import spray_rates

		water_required = spray_rates.needs_water([p["item_code"] for p in products], crop, prefer_area=True)

	reentry = flt(wo.get("custom_reentry_period_hrs"))
	phi = flt(wo.get("custom_phi_days"))
	classification = _text(wo.custom_classification)
	if classification and _text(wo.custom_preventive_reason):
		classification = f"{classification}: {_text(wo.custom_preventive_reason)}"
	return {
		"work_order": work_order,
		"stopped": bool(life.get("stopped")) or wo.docstatus == 2,
		"steps": life.get("steps") or [],
		"block": open_field._short(block) if block else None,
		"farm": farm,
		"location": location,
		"area_ha": area_ha,
		"crop": crop,
		"variety": _text(wo.custom_variety) or _text((cycle or {}).get("variety")),
		"crop_stage": _text((cycle or {}).get("current_stage")),
		"app_week": week,
		"operator": _operator(wo),
		"products": products,
		"equipment": _text(wo.custom_kit),
		"method": _text(wo.get("custom_method_of_application")),
		"water_l": water_l,
		"water_required": water_required,
		"spray": {
			"targets": ", ".join(t for t in (wo.custom_targets or "").split("\n") if t.strip()) or None,
			"classification": classification,
			"reentry": f"{reentry:g} h" if reentry else None,
			"phi": f"{phi:g} days" if phi else None,
		},
	}


@frappe.whitelist()
def get_spray_ticket(work_order: str) -> dict:
	return build_ticket(gather(work_order))


def ticket_for_print(work_order: str) -> dict:
	"""Jinja entry for the print format: the same ticket, the same access check
	(``get_lifecycle`` raises PermissionError), plus ``by_key`` for template lookups."""
	t = get_spray_ticket(work_order)
	t["by_key"] = {l["key"]: l for l in t["lines"]}
	return t
