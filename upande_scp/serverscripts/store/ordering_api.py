"""Per-crop, per-plant-part observation ordering editor backend.

Powers Settings → Ordering. Lets a General Manager decide which pests /
diseases show first under each plant part on the mobile scouting screen, by
editing the ``priorities`` (Filter Priority) child rows on each crop's
Pest Filter / Disease Filter. Lower priority = shown first; blank/0 = unranked
(keeps the default order).

Mirrors thresholds_api: read is whitelisted; write is gated to the settings
roles. Reuses thresholds_api.list_crops for the crop picker.
"""

import json

import frappe

_WRITE_ROLES = {"System Manager", "Administrator", "SCP General Manager"}

# Preferred column order for the known plant parts; matches the mobile tab
# order. Anything else follows alphabetically after these.
_PREFERRED = ["buds", "top", "middle", "stem", "base"]


def _check_write_perm():
    roles = set(frappe.get_roles(frappe.session.user) or [])
    if not (roles & _WRITE_ROLES):
        frappe.throw(
            "You need a Spray Plan settings role to edit ordering.",
            frappe.PermissionError,
        )


def _ordered_sections(crop: str) -> list:
    """Plant sections to show as columns: the crop's configured sections if
    any, else every Plant Section. Ordered by the preferred list, rest after."""
    secs = frappe.get_all(
        "Plant Section Filter",
        filters={"parent": crop, "parenttype": "Crop Scouted"},
        pluck="plant_section",
    )
    if not secs:
        secs = frappe.get_all("Plant Section", pluck="name")
    seen = list(dict.fromkeys(s for s in secs if s))

    def key(s):
        low = s.strip().lower()
        return (_PREFERRED.index(low) if low in _PREFERRED else len(_PREFERRED), s)

    return sorted(seen, key=key)


def _build_rows(filter_doctype: str, link_field: str, crop: str) -> list:
    rows = frappe.get_all(
        filter_doctype,
        filters={"crop_scouted": crop},
        fields=["name", link_field],
        order_by="idx",
    )
    names = [r["name"] for r in rows] or [""]
    prio = frappe.get_all(
        "Filter Priority",
        filters={"parent": ["in", names], "parenttype": filter_doctype},
        fields=["parent", "plant_section", "priority"],
    )
    by_row: dict = {}
    for p in prio:
        if not p.get("plant_section") or p.get("priority") is None:
            continue
        by_row.setdefault(p["parent"], {})[p["plant_section"]] = p["priority"]
    return [
        {"row": r["name"], "name": r[link_field], "priorities": by_row.get(r["name"], {})}
        for r in rows
    ]


@frappe.whitelist()
def get_priorities(crop: str) -> dict:
    """Editor payload: ordered plant-section columns + per-pest/disease ranks."""
    crop = (crop or "").strip()
    if not crop:
        return {"crop": "", "sections": [], "pests": [], "diseases": []}
    return {
        "crop": crop,
        "sections": _ordered_sections(crop),
        "pests": _build_rows("Pest Filter", "pest", crop),
        "diseases": _build_rows("Disease Filter", "disease", crop),
    }


def _save_group(rows: list, filter_doctype: str) -> int:
    """Replace each filter row's Filter Priority children with the ranks from
    the payload. Only positive integer ranks are stored; blank/0 = unranked."""
    saved = 0
    for row in rows or []:
        name = row.get("row")
        if not name:
            continue
        frappe.db.delete("Filter Priority", {"parent": name, "parenttype": filter_doctype})
        idx = 1
        for section, rank in (row.get("priorities") or {}).items():
            try:
                rank_val = int(rank)
            except (TypeError, ValueError):
                continue
            if rank_val <= 0 or not section:
                continue
            fp = frappe.new_doc("Filter Priority")
            fp.parent = name
            fp.parenttype = filter_doctype
            fp.parentfield = "priorities"
            fp.idx = idx
            fp.plant_section = section
            fp.priority = rank_val
            fp.db_insert()
            idx += 1
            saved += 1
    return saved


def _validate_unique_ranks(rows: list, label: str) -> None:
    """A rank must be unique within a plant-part column for the group — two
    pests can't both be #1 on Buds. Raises if violated."""
    seen: dict = {}
    for row in rows or []:
        name = row.get("name") or row.get("row")
        for section, rank in (row.get("priorities") or {}).items():
            try:
                rank_val = int(rank)
            except (TypeError, ValueError):
                continue
            if rank_val <= 0:
                continue
            seen.setdefault(section, {}).setdefault(rank_val, []).append(name)
    dups = []
    for section, ranks in seen.items():
        for rank_val, names in ranks.items():
            if len(names) > 1:
                dups.append(f"{label} · {section}: #{rank_val} → {', '.join(map(str, names))}")
    if dups:
        frappe.throw(
            "Each rank must be unique per plant part. Conflicts: " + "; ".join(dups),
            frappe.ValidationError,
        )


@frappe.whitelist()
def save_priorities(crop: str, payload) -> dict:
    """Persist the ordering matrix. ``payload`` is the shape get_priorities
    returns (the editor sends back the whole thing)."""
    _check_write_perm()
    crop = (crop or "").strip()
    if not crop:
        frappe.throw("Missing crop", frappe.ValidationError)
    if isinstance(payload, str):
        payload = json.loads(payload)

    _validate_unique_ranks(payload.get("pests"), "Pests")
    _validate_unique_ranks(payload.get("diseases"), "Diseases")

    updated = {
        "pests": _save_group(payload.get("pests"), "Pest Filter"),
        "diseases": _save_group(payload.get("diseases"), "Disease Filter"),
    }

    # Drop the observation_types cache so mobile picks up the new order.
    try:
        from upande_scp.serverscripts.common.cache_utils import invalidate, K_OBSERVATION_TYPES
        invalidate(K_OBSERVATION_TYPES)
    except Exception:
        pass

    frappe.db.commit()
    return {"ok": True, "updated": updated}
