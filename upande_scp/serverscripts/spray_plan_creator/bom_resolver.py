"""Per-plan tank-mix BOMs.

Every Application Floor Plan work order gets its OWN BOM, minted from the plan's
recipe, for traceability and so the BOM always matches what was actually issued
(no more falling back to a reused template BOM whose recipe disagrees with the
plan).

Design (see docs/superpowers/specs/2026-06-12-per-recipe-tank-mix-bom-design.md):
  * The tank mix is the FG item (``pm`` / ``dm`` / ``th`` / …).
  * We ALWAYS create a fresh BOM (no dedup) — 1:1 plan↔BOM traceability.
  * The BOM stores the ABSOLUTE per-plan qtys as ``stock_qty`` (== the WO's
    ``required_items`` == the transfer), with ``quantity = 1 Tank Mix (1000L)``
    and ``wo.qty = 1``, so a BOM backflush reproduces the transfer even with the
    ``before_validate`` guard down. The per-1000L recipe rate
    (``required_qty × 1000 / water_volume``) is kept in ``custom_application_rate``
    for display.
  * On a draft re-edit the previously auto-assigned BOM is cancelled if nothing
    real references it (see ``cancel_orphan_plan_bom``).

Manufacture correctness is still enforced independently by
``stock_entry_state.before_validate`` (consume == transferred); this module is
about the BOM record itself.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt

from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate

TANK_MIX_UOM = "Tank Mix (1000L)"
CHEMICAL_MIX = "Chemical Mix"


def _plan_farm(wo) -> str | None:
    farm = (getattr(wo, "custom_farm", None) or "").strip()
    if farm:
        return farm
    gh = getattr(wo, "custom_greenhouse", None)
    if gh:
        return frappe.db.get_value("Warehouse", gh, "custom_farm") or None
    return None


def build_bom_rows(pairs, water_volume) -> dict[str, dict[str, float]]:
    """item_code -> {"qty": absolute, "rate": per-1000L}, from (code, required_qty) pairs.

    ``qty`` is the absolute amount for this plan (== the WO ``required_qty`` ==
    the transfer); it becomes the BOM item ``stock_qty`` so a guard-down BOM
    backflush at ``fg_completed_qty == wo.qty == BOM.quantity == 1`` consumes
    exactly the transfer. ``rate`` is the per-1000L recipe rate
    (``required_qty / (water_volume/1000)``), kept for display in
    ``custom_application_rate``. With no water volume the rate equals the qty
    (factor 1). Blank codes are skipped; duplicate codes are summed.
    """
    rows: dict[str, dict[str, float]] = {}
    for code, required_qty in pairs:
        if not code:
            continue
        rq = flt(required_qty)
        agg = rows.setdefault(code, {"qty": 0.0, "rate": 0.0})
        agg["qty"] = flt(agg["qty"]) + rq
        agg["rate"] = flt(agg["rate"]) + absolute_to_rate(rq, water_volume)
    return rows


def bom_item_payload(item_code, qty, rate, stock_uom) -> dict:
    """One ``bom.items`` row for a per-plan BOM.

    ``qty``/``stock_qty``/``qty_consumed_per_unit`` all carry the ABSOLUTE plan
    quantity so a BOM backflush at ``fg_completed_qty == BOM.quantity`` equals
    the transfer; the per-1000L ``rate`` lands only on the display fields.
    """
    return {
        "item_code": item_code,
        "qty": qty,
        "stock_qty": qty,
        "uom": stock_uom,
        "stock_uom": stock_uom,
        "qty_consumed_per_unit": qty,
        "custom_application_rate": rate,
        "custom_application_rateper_ha_": rate,
        "include_item_in_manufacturing": 1,
        "conversion_factor": 1,
    }


def create_bom_for_plan(wo) -> str | None:
    """Create + submit a NEW BOM whose item stock_qty equal the WO's absolute required_qty.

    Per-1000L rates are stored in ``custom_application_rate`` for display.
    Returns the new BOM name, or None if the plan has no FG item / no chemicals.
    Always creates a fresh BOM (no reuse). ``is_default`` is left 0 so the FG
    item's default BOM is untouched.
    """
    fg_item = getattr(wo, "production_item", None)
    pairs = [(r.item_code, r.required_qty) for r in (wo.required_items or [])]
    rows = build_bom_rows(pairs, getattr(wo, "custom_water_volume", 0))
    if not fg_item or not rows:
        return None

    bom = frappe.new_doc("BOM")
    bom.item = fg_item
    bom.custom_item_group = CHEMICAL_MIX
    bom.company = wo.company
    # custom_business_unit is an optional site-provided Custom Field (was
    # supplied by the old upande_kaitet shim; not owned by any current app).
    # Only touch it where the column actually exists, else the get_value/write
    # throws "Unknown column" on sites without it (e.g. kaitet post-migration).
    if frappe.db.has_column("BOM", "custom_business_unit"):
        bom.custom_business_unit = (
            frappe.db.get_value("BOM", {"item": fg_item}, "custom_business_unit")
            or "Roses"
        )
    farm = _plan_farm(wo)
    if farm:
        bom.custom_farm = farm
    # 1:1 backlink to the originating plan. On the draft-edit path the WO already
    # has a name, so we can set it here; on the create path the WO is unsaved
    # (no name yet) and the caller backfills it post-insert (see set_plan_bom_wo).
    wo_name = getattr(wo, "name", None)
    if wo_name:
        bom.custom_work_order = wo_name
    bom.uom = TANK_MIX_UOM
    bom.quantity = 1
    bom.is_active = 1
    bom.is_default = 0
    if getattr(wo, "custom_water_ph", None):
        bom.custom_water_ph = wo.custom_water_ph
    if getattr(wo, "custom_water_hardness", None):
        bom.custom_water_hardness = wo.custom_water_hardness

    for code, agg in rows.items():
        qty = flt(agg["qty"])
        if qty <= 0:
            continue
        suom = frappe.db.get_value("Item", code, "stock_uom")
        bom.append("items", bom_item_payload(code, qty, flt(agg["rate"]), suom))

    if not bom.items:
        return None

    bom.flags.ignore_permissions = True
    bom.insert()
    bom.submit()
    return bom.name


def set_plan_bom_wo(bom_name: str | None, wo_name: str | None) -> None:
    """Backfill the BOM's plan backlink (``custom_work_order``).

    Needed on the create path, where the BOM is minted before the Work Order is
    inserted and thus before it has a name. ``set_value`` writes the field on the
    already-submitted BOM directly (a backlink, not a recipe change).
    """
    if not bom_name or not wo_name:
        return
    frappe.db.set_value("BOM", bom_name, "custom_work_order", wo_name)


def cancel_orphan_plan_bom(bom_name: str | None, keep_wo: str | None = None) -> bool:
    """Cancel a previously auto-assigned plan BOM if nothing real references it.

    Guards (all must hold) so we never touch a shared / template / in-use BOM:
      * submitted (docstatus 1) and NOT the item's default BOM
      * item group is Chemical Mix
      * referenced by NO submitted Stock Entry (``bom_no``)
      * referenced by NO Work Order other than ``keep_wo``

    In the per-plan flow ``bom_no`` is always our own freshly-minted BOM, so on a
    draft re-edit this safely retires the superseded one. Returns True if
    cancelled.
    """
    if not bom_name:
        return False
    info = frappe.db.get_value(
        "BOM", bom_name,
        ["docstatus", "is_default", "custom_item_group"],
        as_dict=True,
    )
    if not info or info.docstatus != 1 or info.is_default:
        return False
    if (info.custom_item_group or "") != CHEMICAL_MIX:
        return False
    if frappe.db.exists("Stock Entry", {"bom_no": bom_name, "docstatus": 1}):
        return False
    wo_filters: dict = {"bom_no": bom_name}
    if keep_wo:
        wo_filters["name"] = ["!=", keep_wo]
    if frappe.get_all("Work Order", filters=wo_filters, fields=["name"], limit=1):
        return False
    try:
        doc = frappe.get_doc("BOM", bom_name)
        doc.flags.ignore_permissions = True
        if doc.is_active:
            doc.db_set("is_active", 0)
        doc.cancel()
        return True
    except Exception:
        frappe.log_error(
            frappe.get_traceback(), f"cancel_orphan_plan_bom: {bom_name}"
        )
        return False
