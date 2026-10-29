"""Open-field spray planning over several blocks at once.

The greenhouse plan prescribes one house. In the field the planner picks one or
more blocks (avocado blocks, the slices of a pivot) and prescribes each of them
separately; the selection only saves clicks. Every block still gets its own
draft Work Order, made by ``drafts.create_draft_spray_plan`` — so the data model,
the approval workflow, the issue of chemicals and the cost centre (``derive_cost_center``
of the block warehouse) are exactly the greenhouse ones.

Three endpoints:

* ``get_open_field_blocks``   the blocks the user may plan on, grouped by pivot or
  section, with crop, area and cost centre;
* ``get_block_findings``      the pests and diseases scouted on each block lately;
* ``create_draft_plans_batch``  one draft per block, all or nothing.

Nothing here keys on a crop or a location name: groups come from the warehouse
types, crops from ``common.planting``.
"""
from __future__ import annotations

import re

import frappe
from frappe.utils import add_days, flt, nowdate

from ..common import planting
from .drafts import _require_creator, create_draft_spray_plan
from .scope import _resolve_user_scope
from .validation import match_cost_center

GROUP_KINDS = ("Pivot", "Section")
_MAX_DEPTH = 8


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------


def natural_key(name: str):
	"""Sort ``P1-B2`` before ``P1-B10``."""
	return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name or "")]


def group_of(block: str, warehouses: dict) -> tuple:
	"""``(kind, name)`` of the nearest Pivot or Section above ``block``, else ``(None, None)``."""
	seen = {block}
	name = (warehouses.get(block) or {}).get("parent_warehouse")
	for _ in range(_MAX_DEPTH):
		row = warehouses.get(name) if name else None
		if not row or name in seen:
			break
		if (row.get("warehouse_type") or "") in GROUP_KINDS:
			return row["warehouse_type"], name
		seen.add(name)
		name = row.get("parent_warehouse")
	return None, None


def build_groups(blocks: list, warehouses: dict) -> list:
	"""Group ``blocks`` (dicts with ``name``) by pivot / section. Groups in natural
	order, blocks inside in natural order, blocks with no group last."""
	groups: dict = {}
	for b in blocks:
		kind, name = group_of(b["name"], warehouses)
		groups.setdefault((kind, name), []).append(b)
	out = []
	for (kind, name), rows in groups.items():
		rows.sort(key=lambda r: natural_key(r["name"]))
		out.append({"kind": kind, "name": name, "label": _short(name) if name else "Other blocks",
		            "blocks": rows})
	out.sort(key=lambda g: (g["name"] is None, natural_key(g["name"] or "")))
	return out


def _short(name: str) -> str:
	"""``P1-B1 - MUT`` -> ``P1-B1``: the company abbreviation says nothing in a picker."""
	return re.sub(r"\s+-\s+[A-Z0-9]{2,5}$", "", name or "")


def roll_up_findings(rows: list, blocks: list) -> dict:
	"""``{block: {pests, diseases, targets}}`` from ``{block, kind, name, count, last_seen}`` rows."""
	out = {b: {"pests": [], "diseases": [], "targets": []} for b in blocks}
	acc: dict = {}
	for r in rows:
		if r["block"] not in out:
			continue
		key = (r["block"], r["kind"], r["name"])
		cur = acc.setdefault(key, {"name": r["name"], "count": 0, "last_seen": None})
		cur["count"] += flt(r.get("count")) or 0
		seen = str(r.get("last_seen") or "")
		if seen and (not cur["last_seen"] or seen > cur["last_seen"]):
			cur["last_seen"] = seen
	for (block, kind, _), v in acc.items():
		v["count"] = int(v["count"]) if float(v["count"]).is_integer() else v["count"]
		out[block]["pests" if kind == "pest" else "diseases"].append(v)
	for b in out.values():
		b["pests"].sort(key=lambda v: (-flt(v["count"]), v["name"]))
		b["diseases"].sort(key=lambda v: (-flt(v["count"]), v["name"]))
		b["targets"] = [v["name"] for v in b["pests"] + b["diseases"]]
	return out


def plan_problems(plan: dict) -> list:
	"""What a block's plan still lacks before it can be a draft. Pure."""
	out = []
	cls = plan.get("custom_classification") or ""
	if cls not in ("Curative", "Preventive"):
		out.append("choose Preventive or Curative")
	elif cls == "Preventive" and len((plan.get("custom_preventive_reason") or "").strip()) < 20:
		out.append("a preventive plan needs a reason of at least 20 characters")
	if not (plan.get("custom_spray_team") or plan.get("custom_spray_plan_team_members")):
		out.append("pick a spray team")
	if not plan.get("production_item"):
		out.append("pick a tank mix")
	if not [c for c in (plan.get("chemicals") or []) if c.get("item_code")]:
		out.append("add at least one chemical")
	if flt(plan.get("custom_water_volume")) <= 0:
		out.append("water volume must be above zero (does the block have an area?)")
	return out


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


def _scope_blocks(user: str) -> list:
	scope = _resolve_user_scope(user)
	return [
		w for w in scope["warehouses"]
		if (w.get("warehouse_type") or "") == "Block" and w.get("custom_farm")
	]


@frappe.whitelist()
def get_open_field_blocks(crop: str | None = None) -> dict:
	"""``{groups: [{kind, name, label, blocks: [{name, label, farm, crop, crop_label, area_ha,
	cost_center}]}]}`` for the blocks the user may plan on. ``crop`` keeps only the blocks
	currently growing it."""
	user = _require_creator()
	blocks = _scope_blocks(user)
	names = [b["name"] for b in blocks]
	if not names:
		return {"groups": []}
	crops = planting.crops_for_stations(names)
	labels = {
		r.name: r.crop_name or r.name
		for r in frappe.get_all("Crop Scouted", fields=["name", "crop_name"])
	}
	extra = {
		r.name: r
		for r in frappe.get_all(
			"Warehouse", filters={"name": ["in", names]}, fields=["name", "custom_area_ha"],
			limit_page_length=0,
		)
	}
	rows = []
	for b in blocks:
		c = crops.get(b["name"])
		if crop and c != crop:
			continue
		rows.append({
			"name": b["name"],
			"label": _short(b["name"]),
			"farm": b.get("custom_farm"),
			"crop": c,
			"crop_label": labels.get(c, c) if c else None,
			"area_ha": flt((extra.get(b["name"]) or {}).get("custom_area_ha")),
			"cost_center": match_cost_center(b["name"]),
		})
	warehouses = _ancestors([r["name"] for r in rows])
	return {"groups": build_groups(rows, warehouses)}


def _ancestors(stations: list) -> dict:
	out: dict = {}
	todo = {s for s in stations if s}
	for _ in range(_MAX_DEPTH):
		todo -= set(out)
		if not todo:
			break
		rows = frappe.get_all(
			"Warehouse", filters={"name": ["in", list(todo)]},
			fields=["name", "parent_warehouse", "warehouse_type"], limit_page_length=0,
		)
		for r in rows:
			out[r["name"]] = r
		todo = {r["parent_warehouse"] for r in rows if r.get("parent_warehouse")}
	return out


@frappe.whitelist()
def get_block_findings(blocks, days: int = 30) -> dict:
	"""Pests and diseases scouted on each block in the last ``days`` days:
	``{block: {pests: [{name, count, last_seen}], diseases: [...], targets: [names]}}``."""
	_require_creator()
	blocks = frappe.parse_json(blocks) if isinstance(blocks, str) else (blocks or [])
	blocks = [b for b in dict.fromkeys(blocks) if b]
	if not blocks:
		return {}
	since = add_days(nowdate(), -int(days or 30))
	rows = frappe.db.sql(
		"""select se.block as block, 'pest' as kind, p.pest as name,
		          sum(coalesce(p.count, 1)) as count, max(se.date_of_capture) as last_seen
		   from `tabScouting Entry` se join `tabPests Scouting Entry` p on p.parent = se.name
		   where se.block in %(b)s and se.date_of_capture >= %(since)s and ifnull(p.pest, '') != ''
		   group by se.block, p.pest
		   union all
		   select se.block, 'disease', d.disease, count(*), max(se.date_of_capture)
		   from `tabScouting Entry` se join `tabDiseases Scouting Entry` d on d.parent = se.name
		   where se.block in %(b)s and se.date_of_capture >= %(since)s and ifnull(d.disease, '') != ''
		   group by se.block, d.disease""",
		{"b": tuple(blocks), "since": since},
		as_dict=True,
	)
	return roll_up_findings(rows, blocks)


@frappe.whitelist()
def create_draft_plans_batch(plans) -> dict:
	"""One draft spray plan per block, all or nothing.

	``plans`` is a list of ``create_draft_spray_plan`` payloads, one per block (the block
	is ``custom_greenhouse``). Every plan is checked for completeness first; then the drafts
	are made inside a savepoint, so a failure on any block leaves none of them behind and
	the error names that block. Returns ``{results: [{block, work_order, warnings, compliance}]}``."""
	_require_creator()
	plans = frappe.parse_json(plans) if isinstance(plans, str) else (plans or [])
	if not plans:
		frappe.throw("Select at least one block and plan it.", title="Nothing to plan")
	blocks = [(p.get("custom_greenhouse") or "").strip() for p in plans]
	if not all(blocks):
		frappe.throw("Every plan needs a block.", title="Block missing")
	dupes = sorted({b for b in blocks if blocks.count(b) > 1})
	if dupes:
		frappe.throw(f"Block {', '.join(dupes)} is planned twice.", title="Duplicate block")
	problems = [f"{b}: {', '.join(plan_problems(p))}" for b, p in zip(blocks, plans) if plan_problems(p)]
	if problems:
		frappe.throw("<br>".join(problems), title="Plans incomplete")

	frappe.db.savepoint("open_field_batch")
	results = []
	try:
		for block, plan in zip(blocks, plans):
			try:
				r = create_draft_spray_plan(plan)
			except Exception as e:
				raise _BlockError(block, e) from e
			results.append({"block": block, "work_order": r.get("work_order"),
			                "warnings": r.get("warnings") or [], "compliance": r.get("compliance")})
	except _BlockError as e:
		frappe.db.rollback(save_point="open_field_batch")
		frappe.throw(f"{e.block}: {e.reason}", title="Batch not created")
	return {"results": results}


class _BlockError(Exception):
	def __init__(self, block: str, cause: Exception):
		self.block = block
		self.reason = re.sub(r"<[^>]+>", " ", str(cause)).strip()
		super().__init__(f"{block}: {self.reason}")
