"""Heatmaps grid aggregator.

Single endpoint that returns every (greenhouse × pest|disease) card the
page renders for the given filter. One SQL pass groups by
``(greenhouse, obs_name, date_of_capture, zone)`` so the Python pass that
follows is linear in the result-row count.

The page used to fetch raw entries via ``useScouting`` and aggregate
client-side. At 250k+ entries that was unworkable — see
``docs/superpowers/specs/2026-05-18-heatmaps-bed-symbol-design.md``.
"""

import re

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._trends import (
    _fetch_spray_events,
    week_key,
)
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
    stage_icon_map,
)
from upande_scp.serverscripts.scouting.get_complete_scouting_entries import (
    _cached_disease_colors,
    _cached_pest_colors,
)


_KIND_TABLE = {
    "pest":    ("tabPests Scouting Entry",    "pest",    "pests_legend_color"),
    "disease": ("tabDiseases Scouting Entry", "disease", "disease_legend_color"),
}


def heatmaps_grid(args: dict, force: bool = False) -> dict:
    job_id = (args.get("job_id") or "").strip()

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}

    # Greenhouse scope: prefer an explicit list of selections (the Trends-
    # style tristate picker sends an array); fall back to the single
    # ``greenhouse`` / ``farm`` form so older callers (and the smoke
    # tests) keep working.
    explicit = args.get("greenhouses")
    if isinstance(explicit, list) and explicit:
        scope = [str(g).strip() for g in explicit if str(g).strip()]
    else:
        scope = resolve_greenhouse_scope(
            (args.get("greenhouse") or "").strip(),
            (args.get("farm") or "").strip(),
            farms_map,
        )

    filters = {
        "from_date":   args.get("from_date", ""),
        "to_date":     args.get("to_date", ""),
        "crop":        (args.get("crop") or "").strip(),
        # Stash the scope (sorted) in the cache key so different greenhouse
        # selections don't collide.
        "scope_key":   "|".join(sorted(scope)) if isinstance(scope, list) else "",
    }
    return cached_aggregate(
        "heatmaps_grid",
        filters,
        lambda: _build(filters, scope, job_id),
        force=force,
    )


def _build(filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )

    publish_progress(job_id, 25, "loading pest rows")
    pest_rows = _query_kind(where, params, "pest")

    publish_progress(job_id, 55, "loading disease rows")
    disease_rows = _query_kind(where, params, "disease")

    publish_progress(job_id, 80, "building cards")
    pest_colors = _cached_pest_colors()
    pest_color_map = {
        r["name"]: r.get("pests_legend_color")
        for r in pest_colors if r.get("name")
    }
    disease_colors = _cached_disease_colors()
    disease_color_map = {
        r["name"]: r.get("disease_legend_color")
        for r in disease_colors if r.get("name")
    }
    cards = _build_cards(pest_rows, "pest", pest_color_map, weeks_limit=1)
    cards.extend(_build_cards(disease_rows, "disease", disease_color_map, weeks_limit=1))
    # Most-active first across both kinds, then stable order. obsKind is
    # appended so a pest and a disease sharing a name in the same
    # greenhouse still resolve to a total order.
    cards.sort(key=lambda c: (-c["totalObs"], c["greenhouse"], c["obsName"], c["obsKind"]))

    publish_progress(job_id, 100, "")
    return {"cards": cards}


def _query_kind(where: str, params: dict, mode: str) -> list:
    """One SQL pass over the child table for ``mode``, grouped by
    (greenhouse, obs_name, date, zone)."""
    table, col, _color_field = _KIND_TABLE[mode]
    # Pests have a numeric count; diseases don't (one row = one
    # observation), so we sum-with-fallback for the former and
    # count rows for the latter.
    count_expr = (
        "SUM(GREATEST(COALESCE(c.`count`, 1), 1))"
        if mode == "pest"
        else "COUNT(*)"
    )
    return frappe.db.sql(
        f"""
        SELECT
            COALESCE(NULLIF(se.greenhouse, ''), se.block)   AS greenhouse,
            c.{col}                                         AS obs_name,
            DATE_FORMAT(se.date_of_capture, '%%Y-%%m-%%d')  AS d,
            se.zone                                         AS zone,
            c.stage                                         AS stage,
            {count_expr}                                    AS n
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
          AND se.zone IS NOT NULL AND se.zone != ''
        GROUP BY 1, 2, 3, 4, 5
        """,
        params,
        as_dict=True,
    )


_BED_NUM_RE = re.compile(r"Bed\s+(\d+)", re.IGNORECASE)


def bed_parity(zone_name: str):
    """'odd' | 'even' | None for a zone, from the bed number in its name
    (``"Torongo GH 07 - KR - Bed 51 - Zone 9"`` → odd).

    Scouts cover a greenhouse in two passes — odd beds one session, even beds
    another — so parity is what tells us whether a week saw the whole house or
    only half of it. Measured on this site: sessions split 930/16 even vs
    896/16 odd, each covering 114 of 224 beds.
    """
    m = _BED_NUM_RE.search(zone_name or "")
    if not m:
        return None
    return "odd" if int(m.group(1)) % 2 else "even"


# A session aimed at one parity still records a handful of the other — real
# sessions here split 930 even / 16 odd. So "both parities present" is far too
# weak a test for completeness: one stray zone would pass it. Require the
# minority parity to be a genuine share of the week's zones instead.
_PARITY_BALANCE_MIN = 0.2


def parity_balanced(odd: int, even: int) -> bool:
    """True when a week's zones span both bed parities in real proportion, i.e.
    the greenhouse was scouted often enough to have been seen whole.

    A one-sided session scores ~0.017 and fails; a genuine two-pass week is near
    0.5 and passes.
    """
    total = odd + even
    if not total or not odd or not even:
        return False
    return (min(odd, even) / total) >= _PARITY_BALANCE_MIN


def _build_cards(rows: list, mode: str, color_map: dict, weeks_limit: int = 3) -> list:
    """Walk the per-(gh, obs, date, zone) rows once; emit one card per
    (gh, obs) with aggregate totals + the ``weeks_limit`` most-recent scouted
    ISO WEEKS, oldest first so the latest week reads last.

    Weeks, not sessions. A single session covers only the odd or only the even
    beds, so a per-session heatmap renders half a greenhouse and shows the
    unvisited half as if it were clean — indistinguishable from healthy. Merging
    a week's sessions reassembles the whole house.

    Each week reports whether it actually got both halves (``complete``). Across
    this site since June, 101 of 229 greenhouse-weeks got only one half, so this
    is the common case, not an edge case.
    """
    # by_gh_obs[gh][obs] = {
    #   total, zones: set,
    #   by_date: { date: { zone: count } },
    #   stages_by_date: { date: { zone: [{stage, icon_key, count}] } },
    # }
    icons = stage_icon_map()
    by_gh_obs: dict = {}
    for r in rows:
        gh = r.get("greenhouse") or ""
        obs = r.get("obs_name") or ""
        d = r.get("d") or ""
        z = r.get("zone") or ""
        n = int(r.get("n") or 0)
        if not gh or not obs or not z or n <= 0:
            continue
        by_obs = by_gh_obs.setdefault(gh, {})
        bucket = by_obs.setdefault(obs, {
            "total": 0, "zones": set(), "by_date": {}, "stages_by_date": {},
            "meta": {},
        })
        bucket["total"] += n
        bucket["zones"].add(z)
        # Key by ISO week, not date — a date is half a greenhouse.
        wk = week_key(d)
        if not wk:
            continue
        day = bucket["by_date"].setdefault(wk, {})
        day[z] = day.get(z, 0) + n
        stage = (r.get("stage") or "").strip()
        sday = bucket["stages_by_date"].setdefault(wk, {})
        sday.setdefault(z, []).append({
            "stage": stage,
            "icon_key": icons.get(stage, ""),
            "count": n,
        })
        meta = bucket["meta"].setdefault(
            wk, {"dates": set(), "odd": set(), "even": set()}
        )
        meta["dates"].add(d)
        parity = bed_parity(z)
        if parity:
            meta[parity].add(z)

    # _query_kind groups by (gh, obs, date, zone, stage) with no ORDER BY, so
    # each per-zone stage list was appended in scan order. Each (date, zone)
    # bucket has at most one entry per stage, so sorting by stage alone
    # gives a total order.
    for by_obs in by_gh_obs.values():
        for bucket in by_obs.values():
            for sday in bucket["stages_by_date"].values():
                for zone_stages in sday.values():
                    zone_stages.sort(key=lambda s: s["stage"])

    cards = []
    for gh, by_obs in by_gh_obs.items():
        for obs, bucket in by_obs.items():
            # The `weeks_limit` most-recent scouted weeks, then reversed to
            # OLDEST-first so the latest week reads last — left-to-right is
            # forward in time, which is what a progression should look like.
            # "2026-W29" labels sort lexicographically.
            weeks = sorted(bucket["by_date"].keys(), reverse=True)[:weeks_limit]
            weeks.reverse()
            recent = []
            for w in weeks:
                meta = bucket["meta"].get(w, {})
                sessions = sorted(meta.get("dates") or [])
                odd = len(meta.get("odd") or ())
                even = len(meta.get("even") or ())
                recent.append({
                    # `date` keeps its name for the existing client contract,
                    # but now carries an ISO-week label ("2026-W29").
                    "date": w,
                    "zoneObs": bucket["by_date"][w],
                    "zoneStages": bucket["stages_by_date"].get(w, {}),
                    "sessions": len(sessions),
                    "sessionDates": sessions,
                    "oddZones": odd,
                    "evenZones": even,
                    "complete": parity_balanced(odd, even),
                })
            cards.append({
                "greenhouse":    gh,
                "obsName":       obs,
                "obsKind":       mode,
                "color":         color_map.get(obs) or "#888888",
                "totalObs":      bucket["total"],
                "zonesAffected": len(bucket["zones"]),
                "lastDate":      weeks[-1] if weeks else "",
                "recent":        recent,
            })

    # Most-active first, then greenhouse / obs name for stable ordering.
    cards.sort(key=lambda c: (-c["totalObs"], c["greenhouse"], c["obsName"]))
    return cards


def heatmap_card_detail(args: dict, force: bool = False) -> dict:
    """The 3 most-recent dates for ONE (greenhouse, observation) card.

    The grid ships only recent[0] — the thumbnail's date — because the full
    three-date detail is 99% of a 13.65 MB payload and is read only when a
    card is opened.
    """
    greenhouse = (args.get("greenhouse") or "").strip()
    obs_name = (args.get("obs_name") or "").strip()
    obs_kind = (args.get("obs_kind") or "pest").strip()
    if not greenhouse or not obs_name or obs_kind not in _KIND_TABLE:
        return {"recent": []}

    filters = {
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
        "greenhouse": greenhouse,
        "obs_name":   obs_name,
        "obs_kind":   obs_kind,
    }

    def build():
        where, params = parent_filter_conditions(
            filters["from_date"], filters["to_date"], filters["crop"],
            [greenhouse],
        )
        rows = _query_kind(where, params, obs_kind)
        rows = [r for r in rows if (r.get("obs_name") or "") == obs_name]
        color_map = {obs_name: ""}
        cards = _build_cards(rows, obs_kind, color_map, weeks_limit=3)
        return {"recent": cards[0]["recent"] if cards else []}

    return cached_aggregate("heatmap_card_detail", filters, build, force=force)


def heatmap_terrain(args: dict, force: bool = False) -> dict:
    """Every scouted week in the range for ONE (greenhouse, observation), for the
    3D terrain's playback.

    ``heatmap_card_detail`` caps at 3 weeks, which is too short a morph. This
    returns the whole range ascending, each week carrying its zone counts, its
    completeness (so playback can skip half-scouted weeks) and the control
    actions applied that week.

    Scoped to a single greenhouse + observation, so the cost stays proportional
    to one card no matter how long the range.
    """
    greenhouse = (args.get("greenhouse") or "").strip()
    obs_name = (args.get("obs_name") or "").strip()
    obs_kind = (args.get("obs_kind") or "pest").strip()
    if not greenhouse or not obs_name or obs_kind not in _KIND_TABLE:
        return {"weeks": [], "unitLabel": "zone"}

    filters = {
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
        "greenhouse": greenhouse,
        "obs_name":   obs_name,
        "obs_kind":   obs_kind,
    }

    def build():
        where, params = parent_filter_conditions(
            filters["from_date"], filters["to_date"], filters["crop"],
            [greenhouse],
        )
        rows = _query_kind(where, params, obs_kind)
        rows = [r for r in rows if (r.get("obs_name") or "") == obs_name]
        # weeks_limit far above any real range: we want the whole window, and
        # _build_cards already returns weeks ascending.
        cards = _build_cards(rows, obs_kind, {obs_name: ""}, weeks_limit=520)
        weeks = cards[0]["recent"] if cards else []

        sprays = _fetch_spray_events(
            filters["from_date"], filters["to_date"], [greenhouse]
        )
        for w in weeks:
            w["sprayEvents"] = sprays.get(f"{w['date']}|{greenhouse}", [])

        return {
            "weeks": weeks,
            "greenhouse": greenhouse,
            "obsName": obs_name,
            "obsKind": obs_kind,
        }

    return cached_aggregate("heatmap_terrain", filters, build, force=force)
