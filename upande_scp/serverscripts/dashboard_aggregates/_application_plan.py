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

    filters = {
        "greenhouse": greenhouse,
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
        "pest":       (args.get("pest") or "").strip(),     # actually "obs_name" — kept named "pest" for parity with the old client state
        "section":    (args.get("section") or "").strip(),
        "stage":      (args.get("stage") or "").strip(),
    }
    job_id = (args.get("job_id") or "").strip()
    return cached_aggregate(
        "application_plan_diagnose",
        filters,
        lambda: _build(filters, job_id),
        force=force,
    )


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


def _build(filters: dict, job_id: str = "") -> dict:
    publish_progress(job_id, 10, "loading pest rows")
    pest_rows = _query_kind(filters, "pest")
    publish_progress(job_id, 40, "loading disease rows")
    disease_rows = _query_kind(filters, "disease")

    publish_progress(job_id, 70, "deriving filter options")
    all_rows = pest_rows + disease_rows

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

    publish_progress(job_id, 85, "filtering + aggregating")
    pest = filters["pest"]
    section = filters["section"]
    stage = filters["stage"]

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
        # Some sites (mona) imported zone names wrapped in literal double-quotes
        # in tabScouting Entry.zone. The client matches these keys against zone
        # geometry whose names are quote-stripped at the get_beds_and_zones
        # boundary, so strip here too or no marker ever lands on the plot.
        z = (r.get("zone") or "").strip('"')
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
            color = (
                pest_color_map.get(obs_name)
                or disease_color_map.get(obs_name)
                or "#888888"
            )
            bucket = {"count": 0, "color": color, "kind": r.get("kind") or "pest", "_stages": {}}
            zone_obs[z] = bucket
        bucket["count"] += n
        stg = (r.get("stage") or "").strip()
        s_entry = bucket["_stages"].get(stg)
        if s_entry is None:
            s_entry = {"stage": stg, "icon_key": icons.get(stg, ""), "count": 0}
            bucket["_stages"][stg] = s_entry
        s_entry["count"] += n
        d = str(r.get("d") or "")[:10]
        if d and (latest is None or d > latest):
            latest = d

    # Materialise the per-zone stage list (shape markers) and drop the scratch dict.
    for bucket in zone_obs.values():
        bucket["stages"] = list(bucket.pop("_stages").values())

    publish_progress(job_id, 100, "")
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
        # Roses-only sites (e.g. mona) leave crop_scouted unset on every
        # Scouting Entry, so a strict equality filter drops every row and the
        # diagnose plot / curative targets come back empty. Treat unset crop as
        # a match: the filter only EXCLUDES rows tagged to a *different* crop.
        crop_clause = (
            "AND (se.crop_scouted = %(crop)s "
            "OR se.crop_scouted IS NULL OR se.crop_scouted = '')"
        )
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
