"""Crop-protection finances — what was spent on chemicals and foliars, and on
what it was spent, over a period.

Cost is the ACTUAL value of product consumed: the submitted Stock Entry lines'
``amount`` (qty x valuation), not the work-order plan.

Two stock-entry purposes count as consumption:

  * ``Material Transfer for Manufacture`` — store to WIP, the spray flow.
  * ``Material Issue``                    — issued straight from the store.

``Manufacture`` is excluded because it consumes WIP and would double-count the
transfer that filled it; ``Material Transfer`` is excluded because it moves
stock between stores without consuming it.

Reading only the first purpose — as this report used to — captured about a
quarter of real spend. It missed roughly half of all chemical consumption and
almost all foliar consumption, because mona's foliars are issued directly from
the store by hand.

ATTRIBUTION IS A CONVENTION, NOT A MEASUREMENT. One tank is sprayed at one
rate; nothing in the data says how much of a mixed dose was "for" which pest.
Where a product's own targets pin the cost down, the cell is marked
``attributed``. Where they do not, the cost is divided equally across the plan's
targets and the cell is marked ``split`` — the report must show that difference
so nobody reads a divided figure as a measured one.

Foliars never borrow the plan's pest/disease targets. A foliar with no matching
target lands in the ``Nutrition`` bucket, not spread across the pests that
happened to be in the same tank.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, now_datetime

from upande_scp.serverscripts.common import crop_protection

FINANCE_ROLES = ("General Manager", "System Manager")
NUTRITION = "Nutrition"
UNATTRIBUTED = "Unattributed"

CONSUMPTION_PURPOSES = ("Material Transfer for Manufacture", "Material Issue")

_SQL = """
    SELECT sed.item_code, sed.amount, sed.cost_center,
           i.item_group, i.item_name,
           wo.custom_greenhouse AS greenhouse, wo.custom_targets AS targets,
           COALESCE(gh.custom_farm, '') AS farm
    FROM `tabStock Entry` se
    JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
    JOIN `tabItem` i ON i.name = sed.item_code
    LEFT JOIN `tabWork Order` wo ON wo.name = se.work_order
    LEFT JOIN `tabWarehouse` gh ON gh.name = wo.custom_greenhouse
    WHERE se.docstatus = 1
      AND se.purpose IN %(purposes)s
      AND se.posting_date BETWEEN %(f)s AND %(t)s
      AND i.item_group IN %(groups)s
"""


def _ensure_finance_role() -> None:
    user = frappe.session.user
    if user == "Administrator" or set(frappe.get_roles(user)) & set(FINANCE_ROLES):
        return
    frappe.throw(
        "Crop-protection finances requires the General Manager role.",
        frappe.PermissionError,
    )


def _new_cell():
    return {"value": 0.0, "attributed": 0.0, "split": 0.0, "split_items": set()}


def _product_targets(item_code, cache):
    """The targets recorded on the product's own Chemical/Foliar sidecar."""
    if item_code not in cache:
        doc = crop_protection.get_chemical(item_code) or crop_protection.get_foliar(item_code)
        names = set()
        for t in (doc.get("default_targets") or []) if doc else []:
            if t.get("pest"):
                names.add(t.get("pest"))
            if t.get("disease"):
                names.add(t.get("disease"))
        cache[item_code] = names
    return cache[item_code]


def _attribute(kind, product_targets, plan_targets):
    """(buckets, is_split) — see the module docstring.

    Order matters. "No work order at all" is decided FIRST, for every kind: a
    line issued straight from the store has no greenhouse and no target, and
    inventing a Nutrition bucket for it would file ~9.1M of hand-issued foliar
    under a greenhouse that never received it.
    """
    if not plan_targets:
        return [], False
    relevant = [t for t in plan_targets if t in product_targets]
    if relevant:
        return relevant, False
    if kind == "foliar":
        # Nutrition, never the pests that merely shared the tank.
        return [NUTRITION], False
    return plan_targets, True


@frappe.whitelist()
def chemical_cost_by_target(from_date: str, to_date: str, farm: str | None = None) -> dict:
    """Greenhouse x target crop-protection spend for the period."""
    _ensure_finance_role()

    groups = crop_protection.product_groups()
    empty = {
        "as_of": now_datetime().isoformat(timespec="seconds"),
        "currency": frappe.db.get_default("currency") or "KES",
        "farms": [], "unattributed": [], "untargeted_items": [], "item_names": {},
        "totals_by_kind": {"chemical": 0.0, "foliar": 0.0},
        "grand_total": 0.0,
    }
    if not groups:
        # No configured item groups — `IN ()` is a MariaDB syntax error, and an
        # unconfigured site genuinely has nothing to report.
        return empty

    lines = frappe.db.sql(
        _SQL,
        {"f": from_date, "t": to_date, "groups": groups, "purposes": CONSUMPTION_PURPOSES},
        as_dict=True,
    )

    # Only real pests/diseases become columns — plans also record husbandry ops
    # like "Re-bending" in custom_targets, which are not a spend target.
    valid = set(frappe.get_all("Pest", pluck="name")) | set(
        frappe.get_all("Plant Disease", pluck="name")
    )

    tcache: dict[str, set] = {}
    names: dict = {}                # item_code -> item_name, for readable output
    data: dict = {}                 # farm -> (greenhouse, kind) -> target -> cell
    unattributed: dict = {}         # (cost_center, kind) -> value
    untargeted: dict = {}           # item_code -> {item_name, kind, value}
    totals_by_kind = {"chemical": 0.0, "foliar": 0.0}

    for r in lines:
        amount = flt(r["amount"])
        if not amount:
            continue
        f = r["farm"] or "Unassigned"
        if farm and f != farm:
            continue

        names[r["item_code"]] = r["item_name"] or r["item_code"]
        kind = crop_protection.classify_item_group(r["item_group"]) or "chemical"
        totals_by_kind[kind] = totals_by_kind.get(kind, 0.0) + amount

        product_targets = _product_targets(r["item_code"], tcache)
        if not product_targets:
            u = untargeted.setdefault(
                r["item_code"],
                {"item_code": r["item_code"], "item_name": r["item_name"],
                 "kind": kind, "value": 0.0},
            )
            u["value"] += amount

        plan_targets = [
            t.strip()
            for t in (r["targets"] or "").split("\n")
            if t.strip() and t.strip() in valid
        ]

        buckets, is_split = _attribute(kind, product_targets, plan_targets)
        if not buckets:
            # Issued from the store with no work order: no greenhouse, no
            # target. Reported honestly rather than invented.
            key = (r["cost_center"] or UNATTRIBUTED, kind)
            unattributed[key] = unattributed.get(key, 0.0) + amount
            continue

        share = amount / len(buckets)
        row = data.setdefault(f, {}).setdefault((r["greenhouse"] or "—", kind), {})
        for b in buckets:
            cell = row.setdefault(b, _new_cell())
            cell["value"] += share
            if is_split:
                cell["split"] += share
                cell["split_items"].add(r["item_code"])
            else:
                cell["attributed"] += share

    # ---- shape the payload -------------------------------------------
    farms_out = []
    for f in sorted(data):
        rows = data[f]
        targets = sorted({t for cells in rows.values() for t in cells})
        rows_out = []
        target_totals = dict.fromkeys(targets, 0.0)
        for (greenhouse, kind) in sorted(rows):
            cells = rows[(greenhouse, kind)]
            costs = {}
            for t in targets:
                c = cells.get(t)
                costs[t] = {
                    "value": round(c["value"], 2) if c else 0.0,
                    "attributed": round(c["attributed"], 2) if c else 0.0,
                    "split": round(c["split"], 2) if c else 0.0,
                    "split_items": sorted(c["split_items"]) if c else [],
                }
                if c:
                    target_totals[t] += c["value"]
            rows_out.append({
                "greenhouse": greenhouse,
                "kind": kind,
                "costs": costs,
                "total": round(sum(c["value"] for c in cells.values()), 2),
            })
        farms_out.append({
            "farm": f,
            "targets": targets,
            "rows": rows_out,
            "target_totals": {t: round(v, 2) for t, v in target_totals.items()},
            "total": round(sum(target_totals.values()), 2),
        })

    unattributed_out = sorted(
        ({"cost_center": cc, "kind": k, "value": round(v, 2)}
         for (cc, k), v in unattributed.items()),
        key=lambda x: -x["value"],
    )
    untargeted_out = sorted(
        ({**u, "value": round(u["value"], 2)} for u in untargeted.values()),
        key=lambda x: -x["value"],
    )

    return {
        "as_of": now_datetime().isoformat(timespec="seconds"),
        "currency": frappe.db.get_default("currency") or "KES",
        # item_code -> item_name, so the client can show "Magnum Gold" rather
        # than "CHE00058". Sent once as a lookup instead of repeated on every
        # cell — one chemical can be named by dozens of split cells.
        "item_names": names,
        "farms": farms_out,
        "unattributed": unattributed_out,
        "untargeted_items": untargeted_out,
        "totals_by_kind": {k: round(v, 2) for k, v in totals_by_kind.items()},
        "grand_total": round(
            sum(f["total"] for f in farms_out)
            + sum(u["value"] for u in unattributed_out), 2
        ),
    }
