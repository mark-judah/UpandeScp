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
from upande_scp.serverscripts.common.cache_utils import (
    K_BED_COUNT_BY_GH,
    TTL_SHORT,
    build_bed_count_by_gh,
    get_or_set,
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
    return {"cards": cards, "latestScoutingDate": _latest_scouting_date(filters["crop"])}


def _latest_scouting_date(crop: str = "") -> str:
    """Most recent date_of_capture, so a range with no data can say WHY.

    The page defaults to the last seven days. When scouting data is older than
    that — 2026-07-13 was 29 days before 2026-08-11 on this site — every card
    disappears and the page reads as broken rather than as out of range.
    """
    where = "1=1"
    params: dict = {}
    if crop:
        where = "crop_scouted = %(crop)s"
        params["crop"] = crop
    row = frappe.db.sql(
        f"SELECT MAX(date_of_capture) AS d FROM `tabScouting Entry` WHERE {where}",
        params,
    )
    return str(row[0][0])[:10] if row and row[0] and row[0][0] else ""


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


def bed_of_zone(zone_name: str):
    """Bed number as an int from a zone name, or None.

    Used for the per-week sample size — how many beds a week actually covered,
    which is the number to show beside a partial week instead of hiding it.
    """
    m = _BED_NUM_RE.search(zone_name or "")
    return int(m.group(1)) if m else None


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
            wk, {"dates": set(), "odd": set(), "even": set(), "beds": set()}
        )
        meta["dates"].add(d)
        parity = bed_parity(z)
        if parity:
            meta[parity].add(z)
        bed = bed_of_zone(z)
        if bed:
            meta["beds"].add(bed)

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
                beds = len(meta.get("beds") or ())
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
                    # Sample size, so a partial week can be shown WITH its
                    # coverage rather than withheld.
                    "bedsScouted": beds,
                    "zonesScouted": odd + even,
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
        recent = cards[0]["recent"] if cards else []
        # Who walked the house that week, and how much of it they reached.
        extra = scouts_and_coverage(
            greenhouse, filters["from_date"], filters["to_date"], filters["crop"]
        )
        for w in recent:
            w.update(extra.get(w["date"]) or {})
        return {"recent": recent}

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
        extra = scouts_and_coverage(
            greenhouse, filters["from_date"], filters["to_date"], filters["crop"]
        )
        for w in weeks:
            w["sprayEvents"] = sprays.get(f"{w['date']}|{greenhouse}", [])
            w.update(extra.get(w["date"]) or {})

        return {
            "weeks": weeks,
            "greenhouse": greenhouse,
            "obsName": obs_name,
            "obsKind": obs_kind,
        }

    return cached_aggregate("heatmap_terrain", filters, build, force=force)


# ---------------------------------------------------------------------------
# Who scouted, and how much of the house they covered
# ---------------------------------------------------------------------------

def scout_initials(full_name: str) -> str:
    """"AUSTINE OTIENO" → "AO"; a single name → its first two letters.

    A FALLBACK for when the Employee record carries no photo. The photo is the
    intended presentation and callers must prefer `Employee.image` whenever it
    is set. Only ~250 of 4,055 employees have one today, but that is a data gap
    to be filled, not a reason to treat initials as the normal case.
    """
    parts = [p for p in (full_name or "").replace(".", " ").split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    # First and LAST, so "CHRISTINE JEPTOO CHERUIYOT" → "CC" rather than "CJ".
    return (parts[0][0] + parts[-1][0]).upper()


def _titleise(name: str) -> str:
    """Employee names are stored upper-case; render them readably."""
    return " ".join(w.capitalize() for w in (name or "").split())


def scouts_and_coverage(greenhouse: str, from_date: str, to_date: str, crop: str = "") -> dict:
    """``{week: {scouts: [...], bedsScouted, bedsTotal, coveragePct}}``.

    Coverage is BEDS TOUCHED / BEDS THAT EXIST, counting a bed as covered once
    it has at least one entry — that is the "did we walk the whole house"
    question, distinct from the parity check (which asks whether both halves
    were walked) and from zone-level incidence.
    """
    if not greenhouse:
        return {}

    where = ["se.greenhouse = %(gh)s", "se.date_of_capture BETWEEN %(f)s AND %(t)s"]
    params = {"gh": greenhouse, "f": from_date, "t": to_date}
    if crop:
        where.append("se.crop_scouted = %(crop)s")
        params["crop"] = crop

    rows = frappe.db.sql(
        f"""
        SELECT se.date_of_capture AS d, se.bed AS bed,
               se.scouts_name AS emp,
               e.employee_name AS emp_name, e.image AS emp_image
        FROM `tabScouting Entry` se
        LEFT JOIN `tabEmployee` e ON e.name = se.scouts_name
        WHERE {' AND '.join(where)}
          AND se.bed IS NOT NULL AND se.bed != ''
        """,
        params,
        as_dict=True,
    )

    bed_totals = get_or_set(K_BED_COUNT_BY_GH, build_bed_count_by_gh, ttl=TTL_SHORT) or {}
    total_beds = int(bed_totals.get(greenhouse) or 0)

    by_week: dict = {}
    for r in rows:
        wk = week_key(r["d"])
        if not wk:
            continue
        b = by_week.setdefault(wk, {"beds": set(), "scouts": {}})
        bed = bed_of_zone(r["bed"])
        if bed is not None:
            b["beds"].add(bed)
        emp = (r.get("emp") or "").strip()
        if emp:
            s = b["scouts"].setdefault(
                emp,
                {
                    "employee": emp,
                    "name": _titleise(r.get("emp_name") or emp),
                    "image": r.get("emp_image") or "",
                    "entries": 0,
                },
            )
            s["entries"] += 1

    out = {}
    for wk, b in by_week.items():
        scouts = sorted(b["scouts"].values(), key=lambda s: (-s["entries"], s["name"]))
        for s in scouts:
            s["initials"] = scout_initials(s["name"])
        beds = len(b["beds"])
        out[wk] = {
            "scouts": scouts,
            "bedsScouted": beds,
            "bedsTotal": total_beds,
            # 100% only when every bed in the house has at least one record.
            "coveragePct": round(100.0 * beds / total_beds, 1) if total_beds else None,
        }
    return out
