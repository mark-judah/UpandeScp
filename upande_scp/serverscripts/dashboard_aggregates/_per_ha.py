"""Per-hectare figures for the dashboards of block-grown crops (avocado).

An orchard block is judged on its whole scouting round (the ISO week), as the
cumulative count over the round divided by the block's area in hectares —
``scouting/cumulative_per_ha``. This module only shapes that engine's output for
the Overview / Pests / Diseases aggregates; it does not calculate anything of its
own. A crop scouted on greenhouses (roses) never reaches it: ``active`` is False
and the aggregates keep their station-prevalence figures exactly as before.

Everything is for the ISO week holding today ("x / ha this week"), whatever the
dashboard's date range, except the trend, which is one per-ha point per ISO week
across the range. A block without an area has no per-ha figure: it is listed
under ``noArea`` and shown as such, never given an invented one.
"""

from __future__ import annotations

from datetime import timedelta

import frappe

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import cumulative_rules as R
from upande_scp.serverscripts.scouting import cumulative_per_ha as C


def active(crop) -> bool:
    """True for a crop scouted by block — read from its houses, not its name."""
    return bool(crop) and C.is_block_crop(crop)


def _blocks(crop, scope) -> list:
    houses = crop_catalog.greenhouses_for_crop(crop)
    return [h for h in houses if scope is None or h in scope]


def _round(crop):
    days = C.round_days(crop)
    start, end = R.round_bounds(frappe.utils.nowdate(), days)
    return start, end, {"start": str(start), "end": str(end), "days": days, "label": C._round_label(start, end, days)}


def _is_over(fig) -> bool:
    return bool(fig["threshold_per_ha"]) and fig["per_ha"] is not None and fig["per_ha"] >= fig["threshold_per_ha"]


def overview(crop, scope) -> dict:
    """What the Overview needs: per block, how many of its observations are over
    their per-ha line this week (the Alerts column and the High Alerts KPI)."""
    blocks = _blocks(crop, scope)
    start, end, rnd = _round(crop)
    figs = C.round_figures(crop, blocks, start, end)
    over = {b: sum(1 for f in fs if _is_over(f)) for b, fs in figs.items()}
    return {"round": rnd, "overByBlock": over, "overTotal": sum(over.values())}


def kind_payload(kind, crop, scope, filters, from_date, to_date) -> dict:
    """The Pests / Diseases tab's per-hectare figures:

    * ``ranking``  per observation, farm-wide this ISO week (stage / section
      filters honoured): per ha, threshold, blocks over.
    * ``byBlock``  per block, the selected observation (or the kind's observations
      added up when none is picked) this week, over / under its line.
    * ``trend``    one per-ha point per ISO week across the range.
    * ``noArea``   scouted blocks that have no area (no figure for them).
    """
    blocks = _blocks(crop, scope)
    start, end, rnd = _round(crop)
    obs = (filters.get("observation") or "").strip()
    stage = (filters.get("stage") or "").strip() or None
    section = (filters.get("section") or "").strip() or None
    figs = C.round_figures(crop, blocks, start, end, stage, section)
    info = C.block_info(blocks)
    scouted = C._scouted_blocks(blocks, start, end)
    area_of = {b: info.get(b, {}).get("area_ha") for b in blocks}

    ranking = [
        {
            "name": s["observation"], "perHa": s["per_ha"], "cumulative": s["cumulative"],
            "areaHa": s["area_ha"], "threshold": s["threshold_per_ha"] or None,
            "blocksOver": s["blocks_over"], "blocks": s["blocks"], "worst": s["worst"],
            "over": bool(s["threshold_per_ha"]) and (s["per_ha"] or 0) >= s["threshold_per_ha"],
        }
        for s in C.farm_summary(blocks, figs, scouted, area_of)
        if s["kind"] == kind
    ]

    by_block = []
    for b in blocks:
        if b not in scouted:
            continue
        area = area_of.get(b)
        mine = [f for f in figs.get(b, []) if f["kind"] == kind and (not obs or f["observation"] == obs)]
        total = sum(f["cumulative"] for f in mine)
        threshold = mine[0]["threshold_per_ha"] if (obs and mine) else None
        per_ha = R.per_ha(total, area)
        by_block.append({
            "name": b, "perHa": per_ha, "cumulative": total, "areaHa": area, "noArea": area is None,
            "threshold": threshold or None,
            "over": bool(threshold) and per_ha is not None and per_ha >= threshold,
        })
    by_block.sort(key=lambda x: (x["perHa"] is None, -(x["perHa"] or 0), x["name"]))

    trend = C.weekly_per_ha(crop, blocks, from_date, to_date, kind, obs or None, stage, section)
    return {
        "round": rnd,
        "ranking": ranking,
        "byBlock": by_block,
        "trend": [
            {"date": t["date"], "week": t["week"], "value": t["per_ha"], "cumulative": t["cumulative"],
             "areaHa": t["area_ha"]}
            for t in trend
        ],
        "noArea": [b["name"] for b in by_block if b["noArea"]],
        "overCount": sum(r["blocksOver"] for r in ranking),
    }
