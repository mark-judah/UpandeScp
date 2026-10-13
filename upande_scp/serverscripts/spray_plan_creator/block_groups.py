"""Block groups: one spray plan over joined open-field blocks, and the expense
split by area across the blocks' cost centres.

Open-block crops (avocado, coffee — any crop; nothing here keys on a crop name)
are sprayed across adjacent blocks in one run. A plan still has ONE
``custom_greenhouse`` (the largest block, so every downstream consumer keeps
working) plus a ``custom_blocks`` table (``Spray Plan Block``: block, area_ha,
cost_center, share). The rule throughout is "two or more block rows":

* 0 or 1 block  -> no rows are stored and nothing downstream changes.
* 2+ blocks     -> rows are stored, and the plan's expense posting (the
  ``Chemical Spray`` Material Issue, linked back by ``Stock Entry.custom_spray_plan``)
  has each line split by area share across the blocks' cost centres.

Shares are FLOATS in 0..1 (``area / total``). The split itself apportions by the
stored areas, not the rounded shares, with largest-remainder in units of the
qty field's precision, so the parts always sum exactly to the original qty.
Whole-number UOMs apportion whole units; a line with fewer units than blocks
stays on the primary block and the entry's remarks say why.

The split is a Stock Entry ``before_validate`` hook, so every creation path
(the spray-session API, the offline replay, desk, console scripts) gets it, and
it is idempotent: a line already split as expected is left alone, so the second
before_validate on submit does not touch it.
"""
from __future__ import annotations

import math

import frappe
from frappe.utils import cint, flt

BLOCK_DOCTYPE = "Spray Plan Block"
SPLIT_NOTE = "Expense split by block area"
SHARE_PRECISION = 6

# --------------------------------------------------------------------------
# Pure functions (no site needed)
# --------------------------------------------------------------------------


def compute_shares(areas: list[float]) -> list[float]:
	"""``area / total`` per block, rounded to SHARE_PRECISION. Raises on a
	non-positive area — a share would be undefined."""
	if any(flt(a) <= 0 for a in areas):
		raise ValueError("every block needs an area greater than zero")
	total = sum(flt(a) for a in areas)
	return [round(flt(a) / total, SHARE_PRECISION) for a in areas]


def largest_remainder(total_units: int, weights: list[float]) -> list[int]:
	"""Distribute ``total_units`` integer units over ``weights`` (Hamilton).

	Floors each exact quota, then hands the leftover units to the largest
	fractional remainders (ties -> earlier index, i.e. the primary block first
	when it leads the list). The result always sums to ``total_units``."""
	wsum = sum(weights)
	if total_units <= 0 or wsum <= 0:
		return [0] * len(weights)
	quotas = [total_units * w / wsum for w in weights]
	floors = [int(math.floor(q + 1e-9)) for q in quotas]
	left = total_units - sum(floors)
	order = sorted(range(len(weights)), key=lambda i: (-(quotas[i] - floors[i]), i))
	for i in order[:left]:
		floors[i] += 1
	return floors


def split_qty(qty: float, weights: list[float], precision: int, whole: bool = False):
	"""Split ``qty`` by ``weights``.

	Returns ``(parts, reason)``: ``parts`` is a list of quantities aligned with
	``weights`` (zeros allowed — the caller drops them) summing exactly to
	``qty`` at ``precision``; or ``None`` with a human ``reason`` when the line
	cannot be split meaningfully (it then stays on the primary block)."""
	n = len(weights)
	if n < 2:
		return None, "fewer than two blocks"
	if whole:
		units = flt(qty, 0)
		if abs(units - flt(qty)) > 1e-9:
			return None, f"qty {qty} is not a whole number in a whole-number UOM"
		units = int(units)
		if units < n:
			return None, f"{units} whole unit(s) cannot be shared across {n} blocks"
		return [float(u) for u in largest_remainder(units, weights)], None
	scale = 10 ** cint(precision)
	units = int(round(flt(qty) * scale))
	if units < n:
		return None, f"qty {qty} is below the precision needed to share across {n} blocks"
	parts = [u / scale for u in largest_remainder(units, weights)]
	return [flt(p, precision) for p in parts], None


def plan_split(rows: list[dict], blocks: list[dict], precision: int, whole_uoms: set[str]):
	"""The split each group of rows SHOULD have.

	``rows``: ``{key, qty, uom, cost_center}`` dicts (key groups the lines that
	are the same item/batch/warehouse/account). ``blocks``: ``{cost_center,
	area_ha}`` with the primary block first. Returns ``{key: (expected, reason)}``
	where ``expected`` is a list of ``(cost_center, qty)`` (zeros dropped) and
	``reason`` is set when the group stays on the primary block."""
	weights = [flt(b["area_ha"]) for b in blocks]
	primary = blocks[0]["cost_center"]
	totals: dict = {}
	uoms: dict = {}
	for r in rows:
		totals[r["key"]] = totals.get(r["key"], 0.0) + flt(r["qty"])
		uoms[r["key"]] = r.get("uom")
	out = {}
	for key, total in totals.items():
		total = flt(total, precision)
		parts, reason = split_qty(total, weights, precision, whole=uoms[key] in whole_uoms)
		if parts is None:
			out[key] = ([(primary, total)], reason)
			continue
		merged: dict = {}
		order: list = []
		for b, q in zip(blocks, parts):
			if q <= 0:
				continue
			cc = b["cost_center"]
			if cc not in merged:
				order.append(cc)
				merged[cc] = 0.0
			merged[cc] = flt(merged[cc] + q, precision)
		out[key] = ([(cc, merged[cc]) for cc in order], None)
	return out


def already_split(current: list[tuple[str, float]], expected: list[tuple[str, float]], precision: int) -> bool:
	norm = lambda pairs: sorted((cc or "", flt(q, precision)) for cc, q in pairs)  # noqa: E731
	return norm(current) == norm(expected)


# --------------------------------------------------------------------------
# Plan side: resolve and validate custom_blocks on create/update
# --------------------------------------------------------------------------


def _unique(blocks) -> list[str]:
	if isinstance(blocks, str):
		blocks = frappe.parse_json(blocks) if blocks.strip().startswith("[") else [blocks]
	out: list[str] = []
	for b in blocks or []:
		b = (b.get("block") if isinstance(b, dict) else b) or ""
		b = b.strip()
		if not b:
			continue
		if b in out:
			frappe.throw(f"Block {b} is listed twice.", title="Duplicate block")
		out.append(b)
	return out


def normalise_payload_blocks(payload: dict) -> list[str]:
	"""Read ``custom_blocks`` off the payload and settle ``custom_greenhouse``.

	Runs before the scope/compliance checks so they see the final greenhouse.
	Blocks sent without a greenhouse make the largest block the greenhouse; a
	greenhouse sent with blocks it is not among is refused. Returns the block
	list (empty when the payload is a single-block plan)."""
	blocks = _unique(payload.get("custom_blocks"))
	gh = (payload.get("custom_greenhouse") or "").strip()
	if not blocks:
		return []
	if not gh:
		areas = {
			r.name: flt(r.custom_area_ha)
			for r in frappe.get_all(
				"Warehouse", filters={"name": ("in", blocks)}, fields=["name", "custom_area_ha"]
			)
		}
		gh = max(blocks, key=lambda b: (areas.get(b, 0.0), -blocks.index(b)))
		payload["custom_greenhouse"] = gh
	elif gh not in blocks:
		frappe.throw(
			f"The plan's block {gh} is not among the joined blocks ({', '.join(blocks)}).",
			title="Block group",
		)
	return blocks if len(blocks) >= 2 else []


def build_block_rows(blocks: list[str], greenhouse: str, primary_cc: str | None) -> list[dict]:
	"""Validate the joined blocks and return the ``Spray Plan Block`` rows.

	Every block must be a leaf Warehouse of the greenhouse's farm and company,
	with an area. The primary block (the greenhouse) is first and carries the
	plan's own cost centre (which respects the operator's override); the others
	resolve theirs through the same chain the greenhouse does."""
	if len(blocks) < 2:
		return []
	from .validation import derive_cost_center

	meta = {
		r.name: r
		for r in frappe.get_all(
			"Warehouse",
			filters={"name": ("in", blocks)},
			fields=["name", "company", "custom_farm", "custom_area_ha", "is_group", "disabled"],
		)
	}
	gh = meta.get(greenhouse)
	if not gh:
		frappe.throw(f"Block {greenhouse} is not a warehouse.", title="Block group")
	ordered = [greenhouse] + [b for b in blocks if b != greenhouse]
	rows = []
	for b in ordered:
		w = meta.get(b)
		if not w:
			frappe.throw(f"Block {b} is not a warehouse.", title="Block group")
		if w.is_group or w.disabled:
			frappe.throw(f"Block {b} is a group or disabled warehouse.", title="Block group")
		if w.company != gh.company or (w.custom_farm or None) != (gh.custom_farm or None):
			frappe.throw(
				f"Block {b} is on {w.custom_farm or 'no farm'} / {w.company}, but the plan's "
				f"block {greenhouse} is on {gh.custom_farm or 'no farm'} / {gh.company}. "
				"Joined blocks must be on the same farm.",
				title="Block group",
			)
		if flt(w.custom_area_ha) <= 0:
			frappe.throw(
				f"Block {b} has no area (Warehouse area, ha), so its share of the plan "
				"cannot be worked out. Set the block's area first.",
				title="Block without an area",
			)
		cc = primary_cc if b == greenhouse and primary_cc else derive_cost_center(b)
		rows.append({"block": b, "area_ha": flt(w.custom_area_ha), "cost_center": cc})
	shares = compute_shares([r["area_ha"] for r in rows])
	for r, s in zip(rows, shares):
		r["share"] = s
	return rows


def apply_blocks(wo, rows: list[dict]) -> None:
	"""Write the rows onto the Work Order; 2+ rows also set ``custom_area``.
	A single-block plan with no rows is left exactly as it was."""
	if not rows and not getattr(wo, "custom_blocks", None):
		return
	wo.set("custom_blocks", [])
	for r in rows:
		wo.append("custom_blocks", r)
	if rows:
		wo.custom_area = flt(sum(r["area_ha"] for r in rows), 4)


# --------------------------------------------------------------------------
# Posting side: the Stock Entry hook
# --------------------------------------------------------------------------


def _plan_blocks(wo_name: str) -> list[dict]:
	rows = frappe.get_all(
		BLOCK_DOCTYPE,
		filters={"parent": wo_name, "parenttype": "Work Order", "parentfield": "custom_blocks"},
		fields=["block", "area_ha", "cost_center", "share"],
		order_by="idx asc",
	)
	return [r for r in rows if r.cost_center and flt(r.area_ha) > 0]


def _whole_uoms(uoms: set) -> set:
	if not uoms:
		return set()
	return set(frappe.get_all(
		"UOM", filters={"name": ("in", list(uoms)), "must_be_whole_number": 1}, pluck="name"
	))


def _row_key(r) -> tuple:
	return (
		r.item_code, r.s_warehouse or "", r.get("batch_no") or "", r.uom or "",
		flt(r.conversion_factor) or 1.0, r.expense_account or "",
	)


_DROP = {
	"name", "idx", "qty", "transfer_qty", "cost_center", "amount", "basic_amount",
	"serial_and_batch_bundle", "creation", "modified", "owner", "modified_by",
	"docstatus", "parent", "parentfield", "parenttype", "doctype",
}


def split_stock_entry(doc, method=None):
	"""``Stock Entry.before_validate``: split a spray plan's expense posting by
	block area. No-op unless the entry is a Material Issue linked to a plan
	(``custom_spray_plan``) with two or more blocks."""
	if getattr(doc, "purpose", None) != "Material Issue" or doc.docstatus == 2:
		return
	wo_name = doc.get("custom_spray_plan")
	if not wo_name:
		return
	blocks = _plan_blocks(wo_name)
	if len(blocks) < 2:
		return

	items = list(doc.items or [])
	if not items:
		return
	precision = cint(items[0].precision("qty")) or 3
	whole_uoms = _whole_uoms({r.uom for r in items if r.uom})

	keyed = [{"key": _row_key(r), "qty": r.qty, "uom": r.uom, "cost_center": r.cost_center} for r in items]
	plan = plan_split(keyed, blocks, precision, whole_uoms)

	notes: list[str] = []
	new_items: list = []
	done: set = set()
	changed = False
	for r in items:
		key = _row_key(r)
		if key in done:
			continue
		done.add(key)
		group = [x for x in items if _row_key(x) == key]
		expected, reason = plan[key]
		if reason:
			notes.append(f"{r.item_code}: kept on {expected[0][0]} ({reason})")
		if already_split([(g.cost_center, g.qty) for g in group], expected, precision):
			new_items.extend(group)
			continue
		if any(g.get("serial_and_batch_bundle") or g.get("serial_no") for g in group):
			notes.append(f"{r.item_code}: not split (serial/batch bundle already attached)")
			new_items.extend(group)
			continue
		changed = True
		template = {k: v for k, v in r.as_dict().items() if k not in _DROP}
		for cc, q in expected:
			row = frappe._dict(template)
			row.update({"qty": q, "cost_center": cc})
			row.transfer_qty = flt(q * (flt(r.conversion_factor) or 1.0), precision)
			new_items.append(row)

	if changed:
		doc.set("items", [])
		for row in new_items:
			doc.append("items", row)
		for i, row in enumerate(doc.items, start=1):
			row.idx = i
	_write_note(doc, wo_name, blocks, notes)


def _write_note(doc, wo_name, blocks, notes):
	total = sum(flt(b.area_ha) for b in blocks)
	line = f"{SPLIT_NOTE} (plan {wo_name}): " + "; ".join(
		f"{b.block} {flt(b.area_ha)} ha = {flt(b.area_ha) / total * 100:.2f}% -> {b.cost_center}"
		for b in blocks
	)
	if notes:
		line += ". " + "; ".join(notes)
	kept = [ln for ln in (doc.remarks or "").splitlines() if not ln.startswith(SPLIT_NOTE)]
	doc.remarks = "\n".join([*kept, line]).strip()
