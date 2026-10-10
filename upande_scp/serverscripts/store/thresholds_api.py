"""Per-crop, per-stage threshold editor backend.

Powers the Settings → Thresholds tab. Returns and persists the ``measure`` and
the ``low / moderate / high`` bands on every Pest Filter / Disease Filter row of
one crop, and the bands on their Pests Stages / Disease Stages children.

Measures (thresholds spec D1): **Percentage** = piece 2's adjusted prevalence;
**Count** = average count per scouted station, offered only for a pest with a
stage scouts record as a number. Bands must rise strictly over the ones that are
set (D3); all-zero is "unconfigured". A row stored with misordered bands comes
back ``invalid: true`` so the editor flags it; a save that would store one is
refused whole, before any write. The old ``unit`` column stays in the schema but
is neither returned nor written.

Pest stage rows also carry their **role** (Life stage / Form / Sign, read from
the Stage master and edited there) and **weight**: the crop's override of the
Stage's weight in a Count (0 = the Stage's; stage & variety S1, S5, S6).
Diseases carry neither.

Permissions: System Manager / Administrator / SCP General Manager write. Read is
whitelisted so the page can populate for read-only viewers.
"""

import json
import math

import frappe

from upande_scp.serverscripts.common import crop_catalog, stage_roles
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common


_WRITE_ROLES = {"System Manager", "Administrator", "SCP General Manager"}


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


def _f(value) -> float:
    return float(value or 0)


WEIGHT_MAX = 100


def _weight_problem(value) -> str:
    """Why a stage weight cannot be stored, or "" when it can (finite, 0..WEIGHT_MAX)."""
    if value is None or value == "":
        return ""
    try:
        w = float(value)
    except (TypeError, ValueError):
        return "weight must be a number."
    if not math.isfinite(w):
        return "weight must be a finite number."
    if w < 0:
        return "weight cannot be negative."
    if w > WEIGHT_MAX:
        return f"weight cannot exceed {WEIGHT_MAX}."
    return ""


def _filter_rows(crop: str, doctype: str, child: str, obs_col: str, kind: str) -> list:
    measure_col = "measure" if frappe.db.has_column(doctype, "measure") else "'Percentage'"
    parents = frappe.db.sql(
        f"""
        SELECT name, `{obs_col}` AS obs, {measure_col} AS measure,
               low_threshold, moderate_threshold, high_threshold
        FROM `tab{doctype}`
        WHERE crop_scouted = %(crop)s
        ORDER BY idx
        """,
        {"crop": crop},
        as_dict=True,
    )
    with_weights = kind == "pest" and frappe.db.has_column(child, "weight")
    roles = stage_roles.role_map() if kind == "pest" else {}
    stages = frappe.db.sql(
        f"""
        SELECT name, parent, stage, reading_type, {"weight" if with_weights else "0"} AS weight,
               low_threshold, moderate_threshold, high_threshold
        FROM `tab{child}`
        WHERE parenttype = %(pt)s AND parent IN %(parents)s
        ORDER BY parent, idx
        """,
        {"pt": doctype, "parents": [r["name"] for r in parents] or [""]},
        as_dict=True,
    )
    by_parent: dict = {}
    for s in stages:
        by_parent.setdefault(s["parent"], []).append(s)

    out = []
    for r in parents:
        stage_rows = [
            {
                "row": s["name"],
                "stage": s["stage"] or "",
                "reading_type": s["reading_type"] or "",
                "low": _f(s["low_threshold"]),
                "moderate": _f(s["moderate_threshold"]),
                "high": _f(s["high_threshold"]),
                "invalid": not B.bands_ascending(
                    s["low_threshold"], s["moderate_threshold"], s["high_threshold"],
                ),
                **({
                    "role": stage_roles.role_of(s["stage"], roles),
                    "master_weight": stage_roles.master_weight(s["stage"]),
                    "weight": _f(s["weight"]),
                } if kind == "pest" else {}),
            }
            for s in by_parent.get(r["name"], [])
        ]
        row_invalid = not B.bands_ascending(
            r["low_threshold"], r["moderate_threshold"], r["high_threshold"],
        )
        out.append({
            "row": r["name"],
            obs_col: r["obs"],
            "measure": r["measure"] if r["measure"] in B.MEASURES else B.PERCENTAGE,
            "count_allowed": B.count_allowed(kind, [s["reading_type"] for s in stage_rows]),
            "low": _f(r["low_threshold"]),
            "moderate": _f(r["moderate_threshold"]),
            "high": _f(r["high_threshold"]),
            "invalid": row_invalid or any(s["invalid"] for s in stage_rows),
            "stages": stage_rows,
        })
    return out


@frappe.whitelist()
def get_thresholds(crop: str) -> dict:
    """The editor payload for one crop.

    ``station`` is what a Count is "per" (``zone`` / ``tree``). Each row carries
    ``measure``, ``count_allowed`` (a stage with ``reading_type = Count``; never
    for a disease), its bands, ``invalid`` (misordered bands on the row or any
    stage) and ``stages`` with their ``reading_type``, bands and ``invalid``.
    Stage rows are the ones on the doc; the GM adds stages from the doctype.
    """
    crop = crop_catalog.resolve_crop(crop)
    if not crop:
        return {"crop": "", "station": "zone", "pests": [], "diseases": []}
    return {
        "crop": crop,
        "station": _common.station_word(crop),
        "pests": _filter_rows(crop, "Pest Filter", "Pests Stages", "pest", "pest"),
        "diseases": _filter_rows(crop, "Disease Filter", "Disease Stages", "disease", "disease"),
    }


_KINDS = (
    ("pests", "Pest Filter", "Pests Stages"),
    ("diseases", "Disease Filter", "Disease Stages"),
)


def _assert_rows_belong(crop: str, payload: dict) -> None:
    """Refuse the whole save if any row is not `crop`'s (spec §5).

    Checked before the first write: `save_thresholds` commits at the end, so a
    half-applied payload would be permanent.
    """
    for key, doctype, child in _KINDS:
        rows = [r for r in (payload.get(key) or []) if r.get("row")]
        if not rows:
            continue
        owners = dict(frappe.db.sql(
            f"select name, crop_scouted from `tab{doctype}` where name in %(n)s",
            {"n": [r["row"] for r in rows]},
        ))
        wrong = [r["row"] for r in rows if owners.get(r["row"]) != crop]
        if wrong:
            frappe.throw(f"{doctype} rows {', '.join(wrong)} are not {crop} rows.", frappe.ValidationError)
        for r in rows:
            stages = [s["row"] for s in (r.get("stages") or []) if s.get("row")]
            if not stages:
                continue
            parents = dict(frappe.db.sql(
                f"select name, parent from `tab{child}` where name in %(n)s and parenttype = %(pt)s",
                {"n": stages, "pt": doctype},
            ))
            stray = [s for s in stages if parents.get(s) != r["row"]]
            if stray:
                frappe.throw(f"{child} rows {', '.join(stray)} do not belong to {r['row']}.", frappe.ValidationError)


def _validate(payload: dict) -> None:
    """Refuse the whole save on any bad row, before the first write (D1, D3).

    Count is checked against the stages' reading types in the database, never
    against what the client claims. All problems are reported at once.
    """
    errors = []
    for key, doctype, child in _KINDS:
        kind = "pest" if key == "pests" else "disease"
        rows = [r for r in (payload.get(key) or []) if r.get("row")]
        if not rows:
            continue
        reading_types: dict = {}
        for parent, rt in frappe.db.sql(
            f"select parent, reading_type from `tab{child}` where parenttype = %(pt)s and parent in %(n)s",
            {"pt": doctype, "n": [r["row"] for r in rows]},
        ):
            reading_types.setdefault(parent, []).append(rt or "")
        for r in rows:
            label = r.get("pest") or r.get("disease") or r["row"]
            # No key = an old client that does not know measure: the stored one stands.
            measure = r.get("measure") if "measure" in r else None
            if measure is None:
                pass
            elif measure not in B.MEASURES:
                errors.append(f"{label}: unknown measure {measure}.")
            elif measure == B.COUNT and not B.count_allowed(kind, reading_types.get(r["row"])):
                errors.append(f"{label}: Count needs a stage scouts record as a number.")
            if not B.bands_ascending(r.get("low"), r.get("moderate"), r.get("high")):
                errors.append(f"{label}: bands must rise, Low < Moderate < High.")
            for s in r.get("stages") or []:
                if not B.bands_ascending(s.get("low"), s.get("moderate"), s.get("high")):
                    errors.append(
                        f"{label} · {s.get('stage') or s.get('row')}: bands must rise, Low < Moderate < High."
                    )
                if kind == "pest" and "weight" in s:
                    problem = _weight_problem(s.get("weight"))
                    if problem:
                        errors.append(f"{label} · {s.get('stage') or s.get('row')}: {problem}")
    if errors:
        frappe.throw("\n".join(errors), frappe.ValidationError)


@frappe.whitelist()
def save_thresholds(crop: str, payload: str | dict) -> dict:
    """Persist measure + band edits in bulk. ``payload`` is the shape
    ``get_thresholds`` returns (the editor sends back the whole crop).

    Updates existing rows by their ``row`` name only — rows and stages are added
    or removed from the doctype, never here. Validation runs before any write.
    """
    _check_write_perm()

    crop = crop_catalog.resolve_crop(crop)
    if not crop:
        frappe.throw("Missing crop", frappe.ValidationError)
    if isinstance(payload, str):
        payload = json.loads(payload)
    _assert_rows_belong(crop, payload)
    _validate(payload)

    updated = {"pests": 0, "pest_stages": 0, "diseases": 0, "disease_stages": 0}
    for key, doctype, child in _KINDS:
        stage_key = "pest_stages" if key == "pests" else "disease_stages"
        for r in payload.get(key) or []:
            if not r.get("row"):
                continue
            values = {
                "low_threshold": _f(r.get("low")),
                "moderate_threshold": _f(r.get("moderate")),
                "high_threshold": _f(r.get("high")),
            }
            if "measure" in r:
                values["measure"] = r["measure"] or B.PERCENTAGE
            frappe.db.set_value(doctype, r["row"], values, update_modified=True)
            updated[key] += 1
            for s in r.get("stages") or []:
                if not s.get("row"):
                    continue
                stage_values = {
                    "low_threshold": _f(s.get("low")),
                    "moderate_threshold": _f(s.get("moderate")),
                    "high_threshold": _f(s.get("high")),
                }
                if key == "pests" and "weight" in s:
                    # No key = an old client: the stored override stands.
                    stage_values["weight"] = _f(s.get("weight"))
                frappe.db.set_value(child, s["row"], stage_values, update_modified=True)
                updated[stage_key] += 1

    # The next aggregate call must see the new bands immediately.
    _common.clear_threshold_cache()
    stage_roles.invalidate_stage_roles()   # set_value fires no doc_events
    cache = frappe.cache()
    for k in cache.get_keys("scp:dash_agg:*"):
        cache.delete_value(k)
    frappe.db.commit()
    return {"ok": True, "updated": updated}
