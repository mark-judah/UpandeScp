"""Pests and Diseases tabs aggregator (shared).

Percentages are station prevalence (common/prevalence.py): per greenhouse/block
and ISO week over stations SCOUTED, sections averaged, with a margin. Scope-wide
figures weight each house by its station count (``prevalence.combine``).
"""

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._prevalence_rows import ANY
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    house_value,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
    severity_for,
)


def pests(args: dict, force: bool = False) -> dict:
    return _build_endpoint("pest", args, force)


def diseases(args: dict, force: bool = False) -> dict:
    return _build_endpoint("disease", args, force)


_TABLE = {
    "pest":    ("tabPests Scouting Entry",    "pest"),
    "disease": ("tabDiseases Scouting Entry", "disease"),
}


def _build_endpoint(kind: str, args: dict, force: bool) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    job_id = (args.get("job_id") or "").strip()
    filters = {
        "kind": kind,
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
        "observation":(args.get("observation") or "").strip(),
        "section":   (args.get("section") or "").strip(),
        "stage":     (args.get("stage") or "").strip(),
    }
    return cached_aggregate(
        kind + "s",
        filters,
        lambda: _build(kind, filters, scope, job_id),
        force=force,
    )


def _build(kind: str, filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    table, col = _TABLE[kind]
    count_clause = "c.count AS count" if kind == "pest" else "NULL AS count"
    child_obs = obs_filter(kind, f"c.{col}", params)
    publish_progress(job_id, 20, f"loading {kind} observations")
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.zone, se.bed, se.tree,
               c.{col} AS obs_name, c.plant_section AS plant_section,
               c.stage AS stage,
               {count_clause}
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}{child_obs}
        """,
        params,
        as_dict=True,
    )

    publish_progress(job_id, 55, "loading scouted stations")
    # WINDOW: the weekly line (dailyPercent) needs every in-window week, not
    # just each house's latest + previous.
    weeks = _prevalence_rows.StationWeeks.load(
        filters["from_date"], filters["to_date"], filters["crop"], scope, kinds=(kind,),
        weeks=_prevalence_rows.WINDOW,
    )

    publish_progress(job_id, 75, "computing prevalence")
    ranking = _ranking(kind, rows, filters["crop"], weeks)
    fo = _filter_options(rows)
    fo[kind + "s"] = fo.pop("items")

    payload = {
        "filterOptions":      fo,
        "ranking":             ranking,
        "distribution":       _distribution(kind, rows, filters, weeks),
        "sectionSplit":       _section_split(rows, filters),
        "greenhousePressure": _gh_pressure(kind, filters, weeks),
        "dailyPercent":       _daily_percent(kind, filters, weeks),
        "trendSeries":        _trend_series(rows, kind),
    }
    publish_progress(job_id, 100, "")
    return payload


def _ranking(kind: str, rows: list, crop: str, weeks) -> list:
    """Per-observation ranking.

    ``high / moderate / low`` count the (house, stage) cells of the observation
    whose LATEST-week station prevalence classifies into each band against the
    per-stage thresholds (with aggregate fallback) on ``Crop Scouted``. ``total``
    sums the observation counts (pest count for pests, row count for diseases).
    Each row also carries the scope-wide adjusted prevalence of the observation
    (all stages, every scouted house, latest week) with its margin / sections /
    reliability."""
    by_name: dict = {}
    cells: set = set()
    def _bucket(name):
        return by_name.setdefault(
            name, {"name": name, "total": 0, "high": 0, "moderate": 0, "low": 0},
        )

    for r in rows:
        # One key for a NULL observation in both passes ("" here and in the
        # cells), so a NULL-obs child row can neither KeyError nor split in two.
        bucket = _bucket(r.obs_name or "")
        if kind == "pest":
            bucket["total"] += int(r.count or 0)
        else:
            bucket["total"] += 1
        wh = r.block or r.greenhouse or ""
        if wh:
            cells.add((wh, r.obs_name or "", (r.stage or "").strip()))

    for wh, obs_name, stage in sorted(cells):
        fig = weeks.latest(wh, kind, obs_name, stage)
        if not fig or fig["prevalence"] is None:
            continue
        sev = severity_for(crop, kind, obs_name, stage, house_value(crop, kind, obs_name, stage, weeks, wh, fig))
        if sev:
            _bucket(obs_name)[sev] += 1

    for name, bucket in by_name.items():
        bucket.update(P.public(weeks.combined_latest(kind, name or "")))
        bucket["signs"] = (
            _prevalence_rows.signs_combined_latest(weeks, crop, name or "") if kind == "pest" else None
        )

    # by_name is keyed by obs_name, so it's a total-order tie-break.
    return sorted(by_name.values(), key=lambda x: (-x["total"], x["name"]))


def _filter_options(rows: list) -> dict:
    """Returns a dict with key 'items' (kind-agnostic). The caller renames
    'items' -> 'pests' or 'diseases' depending on the kind so the JS-facing
    contract matches the existing client expectations.

    ``stages`` is the flat union across every observation — correct only while
    no specific pest/disease is picked. ``stagesByItem`` narrows it per
    observation so the picker can stop offering, say, a disease's "Latent" stage
    while a pest is selected. Same shape and purpose as the Trends payload's
    ``stagesByObs``.
    """
    obs       = sorted({r.obs_name for r in rows if r.obs_name})
    sections  = sorted({r.plant_section for r in rows if r.plant_section})
    stages    = sorted({(r.stage or "") for r in rows if (r.stage or "")})

    by_item: dict[str, set] = {}
    for r in rows:
        name = r.obs_name
        stage = (r.stage or "").strip()
        if not name or not stage:
            continue
        by_item.setdefault(name, set()).add(stage)

    return {
        "items": obs,
        "sections": sections,
        "stages": stages,
        "stagesByItem": {k: sorted(v) for k, v in by_item.items()},
    }


# ---------------------------------------------------------------------------
# Zone-percent helpers (T10)
# ---------------------------------------------------------------------------

def _zone_key(row) -> str:
    """Mirror aggregate.ts uniqueZoneKey."""
    if row.block:
        return f"{row.block}::tree::{row.tree or ''}"
    if row.zone:
        return f"zone::{row.zone}"
    if row.bed:
        return f"bed::{row.bed}"
    return ""


def _filter_row(row, filters: dict) -> bool:
    """Apply observation/section/stage filters to a single child row."""
    if filters["observation"] and row.obs_name != filters["observation"]:
        return False
    if filters["section"] and row.plant_section != filters["section"]:
        return False
    if filters["stage"] and (row.stage or "") != filters["stage"]:
        return False
    return True


def _select(filters: dict) -> tuple:
    """(observation, stage, section) for StationWeeks; an empty filter is ANY."""
    return (
        filters["observation"] or ANY,
        filters["stage"] or ANY,
        filters["section"] or ANY,
    )


def _distribution(kind: str, rows, filters, weeks) -> list:
    """Per observation: the scope-wide adjusted prevalence in each house's latest
    scouted week (clean houses count), honouring the section and stage filters.
    ``pct`` is None when no house in scope has stations set up."""
    _obs, stage, section = _select(filters)
    names = sorted({
        r.obs_name for r in rows
        if r.obs_name and _filter_row(r, {**filters, "observation": ""})
    })
    out = []
    for name in names:
        fig = weeks.combined_latest(kind, name, stage, section)
        out.append({
            "name": name,
            "zones": (fig or {}).get("infested") or 0,
            "pct": (fig or {}).get("prevalence"),
            **P.public(fig),
        })
    out.sort(key=lambda x: (x["pct"] is None, -(x["pct"] or 0), x["name"]))
    return out


def _section_split(rows, filters) -> list:
    sections = {}
    for r in rows:
        if filters["observation"] and r.obs_name != filters["observation"]:
            continue
        if filters["stage"] and (r.stage or "") != filters["stage"]:
            continue
        sec = (r.plant_section or "Unknown").strip() or "Unknown"
        u = _zone_key(r)
        if not u:
            continue
        sections.setdefault(sec, set()).add(u)
    total = max(1, sum(len(s) for s in sections.values()))
    out = [{"name": n, "zones": len(s),
            "pct": round(len(s) / total * 1000) / 10}
           for n, s in sections.items()]
    # sections is keyed by section name, so it's a total-order tie-break.
    out.sort(key=lambda x: (-x["zones"], x["name"]))
    return out


def _gh_pressure(kind: str, filters, weeks) -> list:
    """One row per house scouted in the range: its latest-week adjusted prevalence
    for the filtered observation / stage / section (any observation when none is
    picked). A house with no stations set up stays, with null figures."""
    obs, stage, section = _select(filters)
    out = []
    for wh in weeks.warehouses():
        fig = weeks.latest(wh, kind, obs, stage, section)
        out.append({
            "name": wh,
            "zones": (fig or {}).get("infested") or 0,
            "pct": (fig or {}).get("prevalence"),
            **P.public(fig),
            "signs": (
                _prevalence_rows.signs_latest(weeks, filters["crop"], wh, obs, section)
                if kind == "pest" and stage is ANY else None
            ),
        })
    # One row per house, so name is a total-order tie-break.
    out.sort(key=lambda x: (x["pct"] is None, -(x["pct"] or 0), x["name"]))
    return out


def _daily_percent(kind: str, filters, weeks) -> list:
    """The trend line: one point per ISO week with scouting in the range, the
    scope-wide adjusted prevalence of the filtered observation that week, dated
    on the week's Monday."""
    obs, stage, section = _select(filters)
    out = []
    for week in weeks.window_weeks():
        fig = weeks.combined(week, kind, obs, stage, section)
        if fig is None:
            continue
        out.append({
            "date": P.week_monday(week),
            "week": week,
            "value": fig["prevalence"],
            "margin": fig["margin"],
            "reliability": fig["reliability"],
        })
    return out


def _trend_series(rows, kind: str, top_n: int = 5) -> dict:
    """One row per date, one key per top-N observation, value = sum of count
    (pest) or 1-per-row (disease)."""
    pairs = {}
    for r in rows:
        bucket = pairs.setdefault(r.obs_name, {"name": r.obs_name, "total": 0,
                                                "daily": {}})
        date = str(r.date_of_capture)[:10]
        v = int(r.count or 0) if kind == "pest" else 1
        bucket["daily"][date] = bucket["daily"].get(date, 0) + v
        bucket["total"] += v
    # pairs is keyed by obs name, so it's a total-order tie-break.
    top = sorted(pairs.values(), key=lambda x: (-x["total"], x["name"]))[:top_n]
    if not top:
        return {"rows": [], "keys": []}
    dates = sorted({d for p in top for d in p["daily"]})
    keys = [p["name"] for p in top]
    out_rows = []
    for d in dates:
        row = {"date": d}
        for p in top:
            row[p["name"]] = p["daily"].get(d, 0)
        out_rows.append(row)
    return {"rows": out_rows, "keys": keys}
