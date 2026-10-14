"""Pest gallery pop-up (roadmap item 8, spec 2026-10-10 G1-G5).

One endpoint behind every clickable pest or disease name on the dashboard: the
master's reference picture and words, who found it in the current scope and
range (by scout), and the scouts' own photos of it.

* **Reference** — ``Pest`` / ``Plant Disease``: ``damage_symptoms`` (a public
  file), ``scientific_name``, ``identification_guideline``.
* **By scout** — cached with the other aggregates. One read of the joined rows
  folded in Python: measured on kaitet.local (Rose, Thrips, 4 weeks, 519k
  entries → 123k Thrips rows) the raw join reads in ~1.4 s, while the same
  figures as a SQL GROUP BY with COUNT(DISTINCT …) take 5.7 s (the string
  expressions force a filesort over the joined set). Count sums live stages
  only — a Sign (damage) recorded as a number is not the pest (stage & variety
  S5); diseases have no count.
* **Photos** — ``Scouting Entry Photo`` rows whose ``subject`` is the
  observation (``subject`` is a bare name with no kind, so a pest and a disease
  sharing a name would mix; the photo row has nothing to tell them apart, and
  requiring a child row on the entry would drop photos taken before the scout
  logged the observation), on entries the scope covers (G4), newest first, a page at a
  time. Uncached: the table is small, and a scout's new photo should show at
  once. The files are private; the browser fetches them with its own session.
"""

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope, stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    coerce_date,
    obs_filter,
    parent_filter_conditions,
    resolve_greenhouse_scope,
)
from upande_scp.serverscripts.scouting import scouting_metrics

PHOTOS_PER_PAGE = 24
MAX_PAGE = 50

_KINDS = {
    # kind: (master doctype, child table, observation column)
    "pest": ("Pest", "tabPests Scouting Entry", "pest"),
    "disease": ("Plant Disease", "tabDiseases Scouting Entry", "disease"),
}

_ROWS = """
SELECT se.scouts_name, {wh}, COALESCE({station}, ''), se.name, se.date_of_capture{count_cols}
FROM `tabScouting Entry` se
JOIN `{child}` c ON c.parent = se.name AND c.parenttype = 'Scouting Entry'
WHERE {where} AND c.`{col}` = %(obs)s{obs}
"""

_PHOTOS = """
SELECT ph.image, ph.caption, ph.captured_on, se.scouts_name, {wh}, se.date_of_capture, se.name
FROM `tabScouting Entry Photo` ph
JOIN `tabScouting Entry` se ON se.name = ph.parent
WHERE ph.parenttype = 'Scouting Entry' AND ph.subject = %(obs)s AND {where}
ORDER BY COALESCE(ph.captured_on, se.date_of_capture) DESC, ph.name DESC
LIMIT %(limit)s OFFSET %(offset)s
"""


def observation_gallery(args: dict, force: bool = False) -> dict:
    kind = (args.get("kind") or "").strip().lower()
    if kind not in _KINDS:
        frappe.throw(f"Unknown observation kind: {kind or '(blank)'}.", frappe.ValidationError)
    name = (args.get("name") or "").strip()
    if not name:
        frappe.throw("An observation name is required.", frappe.ValidationError)
    try:
        page = min(MAX_PAGE, max(0, int(args.get("page") or 0)))
    except (TypeError, ValueError):
        page = 0

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    crop = (args.get("crop") or "").strip()
    scope = _user_scope(scope, crop, (args.get("greenhouse") or "").strip(),
                        (args.get("farm") or "").strip())
    filters = {
        "kind": kind,
        "name": name,
        "from_date": coerce_date(args.get("from_date")),
        "to_date": coerce_date(args.get("to_date")),
        "crop": (args.get("crop") or "").strip(),
        "farm": (args.get("farm") or "").strip(),
        "greenhouse": (args.get("greenhouse") or "").strip(),
        # The effective scope, so one user's payload is never served to another.
        "scope": sorted(scope) if scope is not None else None,
    }
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    # D4: an observation not linked to the crop has nothing to show in it.
    on_crop = not filters["crop"] or name in _crop_list(kind, filters["crop"])
    if not on_crop:
        where = "1=0"

    cached = cached_aggregate(
        "observation_gallery", filters,
        lambda: _summary(filters, where, params), force=force,
    )
    photos, has_more = _photos(name, where, params, page)
    return {**cached, "photos": photos, "photosPage": page, "photosHasMore": has_more}


def _user_scope(scope, crop: str, greenhouse: str, farm: str):
    """Intersect the requested scope with the user's own farms' warehouses.

    A caller-named greenhouse or farm outside the user's reach is refused, not
    silently emptied; a blank request is narrowed to everything they may see.
    """
    allowed = crop_scope.scoped_greenhouses(crop or None)
    if allowed is None:
        return scope
    if greenhouse and greenhouse not in allowed:
        frappe.throw("You do not have access to that greenhouse.", frappe.PermissionError)
    if farm and not greenhouse:
        farms = crop_scope.scoped_farms(crop or None)
        if farms is not None and farm not in farms:
            frappe.throw("You do not have access to that farm.", frappe.PermissionError)
    if scope is None:
        return sorted(allowed)
    return [g for g in scope if g in allowed]


def _crop_list(kind: str, crop: str) -> list:
    if kind == "pest":
        return crop_catalog.pests_for_crop(crop)
    return crop_catalog.diseases_for_crop(crop)


def _summary(filters: dict, where: str, params: dict) -> dict:
    kind, name = filters["kind"], filters["name"]
    return {
        "kind": kind,
        "name": name,
        "reference": _reference(kind, name),
        "showCount": kind == "pest",
        "scouts": _by_scout(filters, where, params),
    }


def _reference(kind: str, name: str) -> dict:
    doctype = _KINDS[kind][0]
    row = frappe.db.get_value(
        doctype, name,
        ["common_name", "scientific_name", "identification_guideline", "damage_symptoms"],
        as_dict=True,
    ) or {}
    return {
        "commonName": row.get("common_name") or name,
        "scientificName": row.get("scientific_name") or "",
        "guideline": row.get("identification_guideline") or "",
        "image": row.get("damage_symptoms") or "",
    }


def _by_scout(filters: dict, where: str, params: dict) -> list:
    if where == "1=0":
        return []
    kind, name = filters["kind"], filters["name"]
    _doctype, child, col = _KINDS[kind]
    is_pest = kind == "pest"
    sql = _ROWS.format(
        wh=R._WH, station=R._STATION, child=child, col=col,
        count_cols=", c.stage, c.`count`" if is_pest else "",
        where=where, obs=obs_filter(kind, f"c.{col}", params),
    )
    rows = frappe.db.sql(sql, {**params, "obs": name})
    signs = frozenset(stage_roles.sign_stages(filters["crop"], name)) if is_pest else frozenset()
    if is_pest and not filters["crop"]:
        roles = stage_roles.role_map()
        signs = frozenset(s for s in {r[5] for r in rows} if stage_roles.role_of(s, roles) == stage_roles.SIGN)

    acc: dict = {}
    for r in rows:
        scout, wh, station, entry, day = r[0], r[1], r[2], r[3], r[4]
        a = acc.get(scout)
        if a is None:
            a = acc[scout] = {"entries": set(), "stations": set(), "houses": set(), "count": 0.0, "last": None}
        a["entries"].add(entry)
        if wh:
            a["houses"].add(wh)
            if station:
                a["stations"].add((wh, station))
        if is_pest and (r[5] or "") not in signs:
            a["count"] += float(r[6] or 0)
        if a["last"] is None or day > a["last"]:
            a["last"] = day

    names = _scout_names(list(acc))
    out = [
        {
            "scout": scout,
            "scoutName": names.get(scout) or scout or "",
            "entries": len(a["entries"]),
            "stations": len(a["stations"]),
            "count": _num(a["count"]) if is_pest else None,
            "houses": len(a["houses"]),
            "lastSeen": coerce_date(a["last"]),
        }
        for scout, a in acc.items()
    ]
    out.sort(key=lambda x: (-x["entries"], x["scoutName"]))
    return out


def _num(v: float):
    return int(v) if float(v).is_integer() else round(v, 2)


def _photos(name: str, where: str, params: dict, page: int) -> tuple:
    if where == "1=0":
        return [], False
    rows = frappe.db.sql(
        _PHOTOS.format(wh=R._WH, where=where),
        {**params, "obs": name, "limit": PHOTOS_PER_PAGE + 1, "offset": page * PHOTOS_PER_PAGE},
    )
    has_more = len(rows) > PHOTOS_PER_PAGE
    rows = rows[:PHOTOS_PER_PAGE]
    names = _scout_names(list({r[3] for r in rows if r[3]}))
    return [
        {
            "image": r[0] or "",
            "caption": r[1] or "",
            "capturedOn": str(r[2] or r[5] or ""),
            "scout": r[3] or "",
            "scoutName": names.get(r[3]) or r[3] or "",
            "house": r[4] or "",
            "date": coerce_date(r[5]),
            "entry": r[6],
        }
        for r in rows
    ], has_more


def _scout_names(ids: list) -> dict:
    if not ids:
        return {}
    return {
        r.name: r.employee_name
        for r in frappe.get_all("Employee", filters={"name": ["in", ids]},
                                fields=["name", "employee_name"], limit_page_length=0)
    }
