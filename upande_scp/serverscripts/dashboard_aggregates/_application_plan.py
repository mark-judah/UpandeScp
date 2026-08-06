"""Application Plan diagnose endpoint.

Returns just what the diagnose step of /scp_app#/application-plan needs:
zone-level observation counts for the selected greenhouse, the latest
scouting date, and the filter-option lists (pests, sections, stages).
The page used to read all of that from the same useScouting payload
that pulls every Rose entry in the date range — that's the "mass data
fetching" the operator wants gone.
"""

import frappe

from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    publish_progress,
    stage_icon_map,
)
from upande_scp.serverscripts.scouting.get_complete_scouting_entries import (
    _cached_disease_colors,
    _cached_pest_colors,
)


def application_plan_diagnose(args: dict, force: bool = False) -> dict:
    greenhouse = (args.get("greenhouse") or "").strip()
    if not greenhouse:
        return _empty()

    # Rows depend only on scope + window. The chips are applied afterwards,
    # so they must NOT be part of this cache key — otherwise every chip
    # click recomputes identical SQL under a fresh key.
    row_filters = {
        "greenhouse": greenhouse,
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
    }
    job_id = (args.get("job_id") or "").strip()
    rows = cached_aggregate(
        "application_plan_rows",
        row_filters,
        lambda: _load_rows(row_filters, job_id),
        force=force,
    )

    chips = {
        "pest":    (args.get("pest") or "").strip(),
        "section": (args.get("section") or "").strip(),
        "stage":   (args.get("stage") or "").strip(),
    }
    result = _shape(rows, chips)
    publish_progress(job_id, 100, "")
    return result


def _load_rows(filters: dict, job_id: str = "") -> list:
    publish_progress(job_id, 10, "loading pest rows")
    pest_rows = _query_kind(filters, "pest")
    publish_progress(job_id, 40, "loading disease rows")
    disease_rows = _query_kind(filters, "disease")
    publish_progress(job_id, 70, "")
    return pest_rows + disease_rows


def _empty() -> dict:
    return {
        "zoneObs":     {},
        "latestDate":  None,
        "filterOpts":  {
            "pests": [], "sections": [], "stages": [],
            "stagesByObs": {}, "sectionsByObs": {},
        },
        "totalRows":   0,
        "targets":     [],
    }


def _shape(all_rows: list, chips: dict) -> dict:
    pests_avail = sorted({r["obs_name"] for r in all_rows if r.get("obs_name")})
    sections = sorted(
        {r["section"] for r in all_rows if r.get("section")}
    )
    stages = sorted({r["stage"] for r in all_rows if r.get("stage")})

    # Cascading menus — when the operator picks a specific pest/disease,
    # the Stage and Plant Section chips narrow to only the values seen
    # for that observation. Keyed by the obs_name as it appears in the
    # client-facing Pest filter chip.
    stages_by_obs: dict = {}
    sections_by_obs: dict = {}
    for r in all_rows:
        obs = r.get("obs_name") or ""
        if not obs:
            continue
        st = r.get("stage") or ""
        if st:
            stages_by_obs.setdefault(obs, set()).add(st)
        sc = r.get("section") or ""
        if sc:
            sections_by_obs.setdefault(obs, set()).add(sc)

    pest_color_map = {
        r["name"]: r.get("pests_legend_color")
        for r in _cached_pest_colors() if r.get("name")
    }
    disease_color_map = {
        r["name"]: r.get("disease_legend_color")
        for r in _cached_disease_colors() if r.get("name")
    }

    pest = chips["pest"]
    section = chips["section"]
    stage = chips["stage"]

    def matches(r) -> bool:
        if pest and r.get("obs_name") != pest:
            return False
        if section and (r.get("section") or "") != section:
            return False
        if stage and (r.get("stage") or "") != stage:
            return False
        return True

    icons = stage_icon_map()
    zone_obs: dict = {}
    latest: str | None = None
    total_rows = 0
    targets_in_scope: set = set()
    for r in all_rows:
        if not matches(r):
            continue
        z = r.get("zone")
        if not z:
            continue
        n = int(r.get("n") or 0)
        if n <= 0:
            continue
        total_rows += n
        obs_name = r.get("obs_name") or ""
        if obs_name:
            targets_in_scope.add(obs_name)
        bucket = zone_obs.get(z)
        if bucket is None:
            bucket = {
                "count": 0,
                "color": "#888888",
                "kind": r.get("kind") or "pest",
                "_stages": {},
                "_rank": None,
            }
            zone_obs[z] = bucket
        bucket["count"] += n
        # color/kind must be deterministic, not first-row-wins over an
        # unordered GROUP BY — but must also reproduce today's actual
        # display rule, which is NOT "alphabetically smallest obs_name
        # globally": _load_rows scans every pest row before any disease
        # row, so a pest always outranks a disease sharing a zone, and
        # alphabetical order only breaks ties within a kind. Rank each row
        # by (0=pest/1=disease, obs_name) and keep the smallest, decided
        # incrementally as rows are scanned (a later row can still
        # displace the current winner) so the result stays plan-independent.
        row_kind = r.get("kind") or "pest"
        rank = (0 if row_kind == "pest" else 1, obs_name)
        if obs_name and (bucket["_rank"] is None or rank < bucket["_rank"]):
            bucket["_rank"] = rank
            bucket["kind"] = row_kind
            color_map = pest_color_map if row_kind == "pest" else disease_color_map
            bucket["color"] = color_map.get(obs_name) or "#888888"
        stg = (r.get("stage") or "").strip()
        s_entry = bucket["_stages"].get(stg)
        if s_entry is None:
            s_entry = {"stage": stg, "icon_key": icons.get(stg, ""), "count": 0}
            bucket["_stages"][stg] = s_entry
        s_entry["count"] += n
        d = str(r.get("d") or "")[:10]
        if d and (latest is None or d > latest):
            latest = d

    # Materialise the per-zone stage list (shape markers) and drop the scratch
    # dict. _stages is keyed by stage name (unique per zone bucket) but was
    # populated in row-scan order, which _query_kind's GROUP BY leaves
    # undefined (no ORDER BY) — sort by stage, like every sibling list in
    # this payload, so the order doesn't depend on the query plan.
    for bucket in zone_obs.values():
        bucket.pop("_rank", None)
        bucket["stages"] = sorted(
            bucket.pop("_stages").values(), key=lambda s: s["stage"],
        )

    return {
        "zoneObs":     zone_obs,
        "latestDate":  latest,
        "filterOpts":  {
            "pests":    pests_avail,
            "sections": sections,
            "stages":   stages,
            "stagesByObs":   {k: sorted(v) for k, v in stages_by_obs.items()},
            "sectionsByObs": {k: sorted(v) for k, v in sections_by_obs.items()},
        },
        "totalRows":   total_rows,
        # Distinct obs names present after applying section/stage/pest
        # filters. When the operator hasn't picked a specific pest, the
        # spray-plan submission walks this list to fill the Targets field.
        "targets":     sorted(targets_in_scope),
    }


def _query_kind(filters: dict, kind: str) -> list:
    """Return rows aggregated by (zone, obs_name, section, stage, date)
    for the given mode within filters[greenhouse, from_date, to_date,
    crop]. Unfiltered by pest/section/stage so the same rows feed both
    the filter-options list and the zoneObs aggregation."""
    if kind == "pest":
        table = "tabPests Scouting Entry"
        col = "pest"
        count_expr = "SUM(GREATEST(COALESCE(c.`count`, 1), 1))"
    else:
        table = "tabDiseases Scouting Entry"
        col = "disease"
        count_expr = "COUNT(*)"

    params: dict = {
        "gh":   filters["greenhouse"],
        "from": filters["from_date"],
        "to":   filters["to_date"],
    }
    crop_clause = ""
    if filters["crop"]:
        crop_clause = "AND se.crop_scouted = %(crop)s"
        params["crop"] = filters["crop"]

    rows = frappe.db.sql(
        f"""
        SELECT se.zone                                  AS zone,
               c.{col}                                  AS obs_name,
               c.plant_section                          AS section,
               c.stage                                  AS stage,
               DATE_FORMAT(se.date_of_capture, '%%Y-%%m-%%d') AS d,
               {count_expr}                             AS n
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE (se.greenhouse = %(gh)s OR se.block = %(gh)s)
          AND se.date_of_capture BETWEEN %(from)s AND %(to)s
          AND se.zone IS NOT NULL AND se.zone != ''
          {crop_clause}
        GROUP BY 1, 2, 3, 4, 5
        """,
        params,
        as_dict=True,
    )
    for r in rows:
        r["kind"] = kind
    return rows
