"""Chemical-cost finances — what each greenhouse spent on chemicals, broken
down by the pest/disease it was spent on, over a period.

Cost is the ACTUAL value of chemicals moved from the store to WIP/CSU — the
submitted ``Material Transfer for Manufacture`` Stock Entries' line ``amount``
(qty x valuation), not the work-order plan. Each moved chemical's cost is
attributed to the pest(s)/disease(s) it actually treats (``Chemical.targets`` ∩
the plan's targets, split equally); when a chemical has no matching target the
cost falls back to the plan's pest/disease targets so the totals reconcile.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, now_datetime

from upande_scp.serverscripts import chemical_meta

FINANCE_ROLES = ("General Manager", "System Manager")
UNSPECIFIED = "Unspecified"


def _ensure_finance_role() -> None:
    user = frappe.session.user
    if user == "Administrator" or set(frappe.get_roles(user)) & set(FINANCE_ROLES):
        return
    frappe.throw(
        "Chemical finances requires the General Manager role.",
        frappe.PermissionError,
    )


@frappe.whitelist()
def chemical_cost_by_target(from_date: str, to_date: str, farm: str | None = None) -> dict:
    """Greenhouse x pest/disease chemical spend for the period.

    Returns ``{farms: [{farm, targets, rows:[{greenhouse, costs{}, total}],
    target_totals{}, total}], grand_total, currency, as_of}``.
    """
    _ensure_finance_role()

    lines = frappe.db.sql(
        """
        SELECT sed.item_code, sed.amount,
               wo.custom_greenhouse AS greenhouse, wo.custom_targets AS targets,
               COALESCE(gh.custom_farm, '') AS farm
        FROM `tabStock Entry` se
        JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
        JOIN `tabWork Order` wo ON wo.name = se.work_order
        LEFT JOIN `tabWarehouse` gh ON gh.name = wo.custom_greenhouse
        WHERE se.docstatus = 1
          AND se.purpose = 'Material Transfer for Manufacture'
          AND se.posting_date BETWEEN %(f)s AND %(t)s
        """,
        {"f": from_date, "t": to_date},
        as_dict=True,
    )

    # Only real pests/diseases become columns (plans also record husbandry ops
    # like "Re-bending" in custom_targets — those aren't a spend target).
    valid = set(frappe.get_all("Pest", pluck="name")) | set(
        frappe.get_all("Plant Disease", pluck="name")
    )

    cache: dict[str, set[str]] = {}

    def chem_targets(code: str) -> set[str]:
        if code not in cache:
            meta = chemical_meta.get_chemical(code) or {}
            names: set[str] = set()
            for t in meta.get("targets", []):
                if t.get("pest"):
                    names.add(t["pest"])
                if t.get("disease"):
                    names.add(t["disease"])
            cache[code] = names
        return cache[code]

    # data[farm][greenhouse][target] = cost
    data: dict[str, dict[str, dict[str, float]]] = {}
    for r in lines:
        f = r["farm"] or "Unassigned"
        if farm and f != farm:
            continue
        amt = flt(r["amount"])
        if not amt:
            continue
        gh = r["greenhouse"] or "—"
        plan_targets = [
            t.strip()
            for t in (r["targets"] or "").split("\n")
            if t.strip() and t.strip() in valid
        ]
        relevant = [t for t in plan_targets if t in chem_targets(r["item_code"])]
        buckets = relevant or plan_targets or [UNSPECIFIED]
        share = amt / len(buckets)
        gdict = data.setdefault(f, {}).setdefault(gh, {})
        for b in buckets:
            gdict[b] = gdict.get(b, 0.0) + share

    farms_out = []
    for f in sorted(data):
        ghs = data[f]
        targets = sorted({t for g in ghs.values() for t in g})
        rows_out = []
        target_totals = dict.fromkeys(targets, 0.0)
        for gh in sorted(ghs):
            cells = ghs[gh]
            rows_out.append({
                "greenhouse": gh,
                "costs": {t: round(cells.get(t, 0.0), 2) for t in targets},
                "total": round(sum(cells.values()), 2),
            })
            for t in targets:
                target_totals[t] += cells.get(t, 0.0)
        farms_out.append({
            "farm": f,
            "targets": targets,
            "rows": rows_out,
            "target_totals": {t: round(v, 2) for t, v in target_totals.items()},
            "total": round(sum(target_totals.values()), 2),
        })

    return {
        "as_of": now_datetime().isoformat(timespec="seconds"),
        "currency": frappe.db.get_default("currency") or "KES",
        "farms": farms_out,
        "grand_total": round(sum(f["total"] for f in farms_out), 2),
    }
