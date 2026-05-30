"""Per-crop, per-stage threshold editor backend.

Powers the Settings → Thresholds tab. Returns and persists the
``low / moderate / high`` numbers stored on every Pest Filter / Disease
Filter row (and their Pests Stages / Disease Stages children) under
each ``Crop Scouted`` doc.

Permissions: System Manager / Administrator / General Manager — same
gate the rest of Settings uses for write paths. Read is whitelisted so
the page can populate before an operator with read-only access tries
to view it.
"""

import json

import frappe


_WRITE_ROLES = {"System Manager", "Administrator", "General Manager"}


def _check_write_perm():
    roles = set(frappe.get_roles(frappe.session.user) or [])
    if not (roles & _WRITE_ROLES):
        frappe.throw(
            "You need a Spray Plan settings role to edit thresholds.",
            frappe.PermissionError,
        )


@frappe.whitelist()
def list_crops() -> list:
    """Crops the GM can pick from in the threshold editor — anything
    that has at least one Pest Filter or Disease Filter row, so empty
    Crop Scouted docs don't show up as targets with nothing to edit."""
    rows = frappe.db.sql(
        """
        SELECT DISTINCT crop
        FROM (
            SELECT crop_scouted AS crop FROM `tabPest Filter` WHERE crop_scouted IS NOT NULL
            UNION
            SELECT crop_scouted AS crop FROM `tabDisease Filter` WHERE crop_scouted IS NOT NULL
        ) t
        WHERE crop != ''
        ORDER BY crop
        """,
        as_dict=True,
    )
    return [r["crop"] for r in rows if r.get("crop")]


@frappe.whitelist()
def get_thresholds(crop: str) -> dict:
    """Return the editor payload for one Crop Scouted.

    ``pests`` and ``diseases`` lists each contain rows with the
    aggregate low/mod/high plus a ``stages`` list of per-stage
    thresholds (only stages that already exist on the doc — the GM
    adds new stage rows from the doctype itself for now).
    """
    crop = (crop or "").strip()
    if not crop:
        return {"crop": "", "pests": [], "diseases": []}

    pest_filters = frappe.db.sql(
        """
        SELECT name, pest, unit,
               low_threshold, moderate_threshold, high_threshold
        FROM `tabPest Filter`
        WHERE crop_scouted = %(crop)s
        ORDER BY idx
        """,
        {"crop": crop},
        as_dict=True,
    )
    pest_stages = frappe.db.sql(
        """
        SELECT name, parent, stage,
               low_threshold, moderate_threshold, high_threshold
        FROM `tabPests Stages`
        WHERE parenttype = 'Pest Filter' AND parent IN %(parents)s
        ORDER BY parent, idx
        """,
        {"parents": [r["name"] for r in pest_filters] or [""]},
        as_dict=True,
    )
    stages_by_pest_row: dict = {}
    for s in pest_stages:
        stages_by_pest_row.setdefault(s["parent"], []).append(s)

    pests = [
        {
            "row":  r["name"],
            "pest": r["pest"],
            "unit": r["unit"] or "Per Zone %",
            "low":       float(r["low_threshold"] or 0),
            "moderate":  float(r["moderate_threshold"] or 0),
            "high":      float(r["high_threshold"] or 0),
            "stages": [
                {
                    "row":   s["name"],
                    "stage": s["stage"] or "",
                    "low":       float(s["low_threshold"] or 0),
                    "moderate":  float(s["moderate_threshold"] or 0),
                    "high":      float(s["high_threshold"] or 0),
                }
                for s in stages_by_pest_row.get(r["name"], [])
            ],
        }
        for r in pest_filters
    ]

    disease_filters = frappe.db.sql(
        """
        SELECT name, disease, unit,
               low_threshold, moderate_threshold, high_threshold
        FROM `tabDisease Filter`
        WHERE crop_scouted = %(crop)s
        ORDER BY idx
        """,
        {"crop": crop},
        as_dict=True,
    )
    disease_stages = frappe.db.sql(
        """
        SELECT name, parent, stage,
               low_threshold, moderate_threshold, high_threshold
        FROM `tabDisease Stages`
        WHERE parenttype = 'Disease Filter' AND parent IN %(parents)s
        ORDER BY parent, idx
        """,
        {"parents": [r["name"] for r in disease_filters] or [""]},
        as_dict=True,
    )
    stages_by_disease_row: dict = {}
    for s in disease_stages:
        stages_by_disease_row.setdefault(s["parent"], []).append(s)

    diseases = [
        {
            "row":     r["name"],
            "disease": r["disease"],
            "unit":    r["unit"] or "Per Zone %",
            "low":       float(r["low_threshold"] or 0),
            "moderate":  float(r["moderate_threshold"] or 0),
            "high":      float(r["high_threshold"] or 0),
            "stages": [
                {
                    "row":   s["name"],
                    "stage": s["stage"] or "",
                    "low":       float(s["low_threshold"] or 0),
                    "moderate":  float(s["moderate_threshold"] or 0),
                    "high":      float(s["high_threshold"] or 0),
                }
                for s in stages_by_disease_row.get(r["name"], [])
            ],
        }
        for r in disease_filters
    ]

    return {"crop": crop, "pests": pests, "diseases": diseases}


@frappe.whitelist()
def save_thresholds(crop: str, payload: str | dict) -> dict:
    """Persist threshold edits in bulk. ``payload`` is the same shape
    ``get_thresholds`` returns (the editor sends back the whole doc).

    We update existing rows by their ``row`` (Frappe doc name) — adding
    or deleting filter rows / stage rows is done via the doctype list
    view, so this endpoint never inserts or deletes; it just refreshes
    the four float columns. That keeps the contract narrow and avoids
    accidentally wiping legacy stage rows that don't appear in the
    editor."""
    _check_write_perm()

    crop = (crop or "").strip()
    if not crop:
        frappe.throw("Missing crop", frappe.ValidationError)
    if isinstance(payload, str):
        payload = json.loads(payload)

    updated = {"pests": 0, "pest_stages": 0, "diseases": 0, "disease_stages": 0}

    for p in payload.get("pests") or []:
        if not p.get("row"):
            continue
        frappe.db.set_value(
            "Pest Filter", p["row"],
            {
                "unit": p.get("unit") or "Per Zone %",
                "low_threshold":      float(p.get("low") or 0),
                "moderate_threshold": float(p.get("moderate") or 0),
                "high_threshold":     float(p.get("high") or 0),
            },
            update_modified=True,
        )
        updated["pests"] += 1
        for s in p.get("stages") or []:
            if not s.get("row"):
                continue
            frappe.db.set_value(
                "Pests Stages", s["row"],
                {
                    "low_threshold":      float(s.get("low") or 0),
                    "moderate_threshold": float(s.get("moderate") or 0),
                    "high_threshold":     float(s.get("high") or 0),
                },
                update_modified=True,
            )
            updated["pest_stages"] += 1

    for d in payload.get("diseases") or []:
        if not d.get("row"):
            continue
        frappe.db.set_value(
            "Disease Filter", d["row"],
            {
                "unit": d.get("unit") or "Per Zone %",
                "low_threshold":      float(d.get("low") or 0),
                "moderate_threshold": float(d.get("moderate") or 0),
                "high_threshold":     float(d.get("high") or 0),
            },
            update_modified=True,
        )
        updated["diseases"] += 1
        for s in d.get("stages") or []:
            if not s.get("row"):
                continue
            frappe.db.set_value(
                "Disease Stages", s["row"],
                {
                    "low_threshold":      float(s.get("low") or 0),
                    "moderate_threshold": float(s.get("moderate") or 0),
                    "high_threshold":     float(s.get("high") or 0),
                },
                update_modified=True,
            )
            updated["disease_stages"] += 1

    # Drop the dashboard threshold cache so the next aggregate call sees
    # the new numbers immediately.
    cache = frappe.cache()
    for key in cache.get_keys("scp:dash_agg:*"):
        cache.delete_value(key)
    frappe.db.commit()
    return {"ok": True, "updated": updated}
