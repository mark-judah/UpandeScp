"""Per-tree hot spots for block-grown crops (avocado).

A block crop is judged at two levels, both live at once:

* the BLOCK, cumulative per hectare over the ISO week against the single
  ``cumulative_per_ha_threshold`` line (``cumulative_per_ha``, one email per
  block x pest x week), and
* the TREE, against the per-tree Moderate / High bands of the Thresholds tab,
  to find where inside a block the problem sits: a **tree hot spot**.

A tree is over its band when its count of the pest this ISO week (every counted
live stage, weighted, summed over the week's visits: the same figure the
Observations map colours a tree by) reaches Moderate. Neighbouring over-band
trees (the 8-neighbour rule of ``common.clusters``: same or adjacent orchard
row, same or adjacent tree) form one hot spot once there are ``MIN_TREES`` (2)
of them: a scouting round samples only some trees of a block (on Lokitela about
40 of 600, in runs), so three adjacent over-band trees is rarely seen even in a
bad patch, while one tree on its own is just a tree. Its band is High when any tree in it reaches
High, else Moderate; its figure is the worst tree's count.

Only a **Count** row can be judged per tree. A Percentage row (diseases,
mealybugs, scale) is a share of scouted stations, and one tree is either
infested or not, so it has no per-tree band and raises no tree hot spot.

Findings take the shape of ``thresholds_check.evaluate``, alert type
``Tree hot spot``, one Scouting Alert per (block, observation, ISO week,
anchor), the anchor being the hot spot's front-most row and tree. Moderate
notifies like Alarming, High like Spray advised (``thresholds_check.upsert``).
Nothing here touches the per-hectare alert or the weekly email's per-ha figures.

The pure rules (``band_of_tree`` ... ``label``) have no frappe import.
"""

from datetime import timedelta

from upande_scp.serverscripts.common import clusters as CL
from upande_scp.serverscripts.common import threshold_bands as B

KIND = "pest"
#: Over-band neighbours needed to call it a hot spot (see the module docstring).
MIN_TREES = 2
TREE_WORD = "tree"


# ── pure ────────────────────────────────────────────────────────────────────


def over_band_trees(counts: dict, spec: dict) -> dict:
    """``{tree: "moderate" | "high"}`` for the trees whose count reaches
    Moderate in ``spec`` (a ``band_spec``)."""
    out = {}
    for tree, value in (counts or {}).items():
        band = B.band_of(value, spec.get("low"), spec.get("mod"), spec.get("high"))
        if band in ("moderate", "high"):
            out[tree] = band
    return out


def label(cluster, band, peak) -> str:
    """``7 trees · rows 12-14, trees 3-9 · High, peak 9 per tree``."""
    n = cluster["size"]
    return (
        f"{n} trees · {CL.label(cluster, 'row')} · "
        f"{B.BAND_LABEL.get(band, band)}, peak {fmt(peak)} per tree"
    )


def fmt(value) -> str:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    return str(int(v)) if v == int(v) else f"{v:.1f}"


def find_spots(ranks: dict, counts: dict, spec: dict) -> list:
    """Every tree hot spot of one block x observation: dicts with ``band``
    (``moderate`` / ``high``), ``peak`` (the worst tree's count), ``trees``,
    ``size``, ``rows``, ``cols`` (0-based rank spans), the anchor
    (``anchor_row``, ``anchor_col``: its front-most row and tree) and ``label``.
    Largest first, then front-most."""
    over = over_band_trees(counts, spec)
    out = []
    found = [CL._shape(g, ranks) for g in CL.components(ranks, over) if len(g) >= MIN_TREES]
    found.sort(key=CL._sort_key)
    for c in found:
        trees = c["stations"]
        band = "high" if any(over[t] == "high" for t in trees) else "moderate"
        peak = max(counts[t] for t in trees)
        out.append({
            **c, "band": band, "peak": peak, "trees": trees,
            "anchor_row": c["rows"][0], "anchor_col": c["cols"][0],
            "label": label(c, band, peak),
        })
    return out


def action_of(band) -> str:
    """Moderate -> Alarming, High -> Spray advised (same notice levels as the
    house alert)."""
    return B.SPRAY_ADVISED if band == "high" else B.ALARMING


# ── findings ────────────────────────────────────────────────────────────────


def tree_keys(crop) -> list:
    """``[(obs, spec)]`` for the crop's pests with a usable Count band on the
    pest row itself (the all-stage figure the map also uses)."""
    from upande_scp.serverscripts.dashboard_aggregates import _common

    out = []
    for (kind, obs, stage), spec in sorted(_common.load_thresholds(crop).items()):
        if kind == KIND and not stage and spec.get("measure") == B.COUNT:
            out.append((obs, spec))
    return out


def has_trees(crop) -> bool:
    """True when the crop's blocks have mapped Orchard Trees: the grid a hot spot
    is read on. A block crop scouted on hexagons (a pivot) has none, so it has no
    tree hot spots and only the per-hectare level."""
    import frappe
    from upande_scp.serverscripts.common import crop_catalog

    blocks = crop_catalog.greenhouses_for_crop(crop)
    return bool(blocks) and bool(frappe.db.exists("Orchard Tree", {"block": ["in", blocks]}))


def spots_in_window(crop, from_date, to_date, blocks=None) -> list:
    """Tree hot spots of every block scouted in the window, each block judged
    in its latest ISO week of it. ``from_date`` / ``to_date`` are ISO dates."""
    from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R

    keys = tree_keys(crop)
    if not keys or not has_trees(crop):
        return []
    weeks = R.StationWeeks.load(from_date, to_date, crop, blocks, kinds=(KIND,), lookback_days=0)
    out = []
    for wh in weeks.warehouses():
        week, previous = weeks.latest_pair(wh)
        if not week:
            continue
        ranks = R.station_ranks(wh)
        for obs, spec in keys:
            counts = weeks.station_counts(
                wh, week, KIND, obs, spec.get("count_stages"), weights=spec.get("count_weights"),
            )
            for s in find_spots(ranks, counts, spec):
                out.append({**s, "warehouse": wh, "kind": KIND, "observation": obs,
                            "iso_week": week, "previous_week": previous})
    return out


def findings(crop, today) -> list:
    """Scouting Alert findings for the crop's tree hot spots in the check's
    window (the last ``EVAL_WINDOW_DAYS`` days to ``today``)."""
    from upande_scp.serverscripts.scouting import thresholds_check as TC

    from_date = (today - timedelta(days=TC.EVAL_WINDOW_DAYS - 1)).isoformat()
    out = []
    for s in spots_in_window(crop, from_date, today.isoformat()):
        out.append({
            "crop": crop, "warehouse": s["warehouse"], "kind": s["kind"], "observation": s["observation"],
            "stage": "", "iso_week": s["iso_week"], "previous_week": s["previous_week"],
            "alert_type": B.TREE_HOT_SPOT, "section_row": s["anchor_row"], "section_col": s["anchor_col"],
            "section_label": s["label"],
            "measure": B.COUNT, "station_word": TREE_WORD, "unit": B.unit_label(B.COUNT, TREE_WORD),
            "value": s["peak"], "house_value": 0, "margin": None, "reliability": "Good",
            "sections_scouted": s["size"], "sections_total": 0,
            "band": s["band"], "action": action_of(s["band"]),
            "trees": s["trees"],
        })
    return out


def spots_for_week(crop, monday, blocks) -> list:
    """The hot spots of the given blocks in the ISO week starting ``monday``
    (the weekly email's week), worst first."""
    spots = spots_in_window(crop, monday.isoformat(), (monday + timedelta(days=6)).isoformat(), blocks)
    spots.sort(key=lambda s: (s["band"] != "high", -s["size"], s["warehouse"], s["observation"]))
    return spots


def open_for_block(block, observation=None) -> list:
    """The block's live (Open / Acknowledged) tree hot spots, from the stored
    Scouting Alerts, worst first: what the block modal and the spray-plan heatmap
    list beside the per-hectare figure."""
    import frappe

    filters = {"warehouse": block, "alert_type": B.TREE_HOT_SPOT, "status": ["in", ["Open", "Acknowledged"]]}
    if observation:
        filters["observation"] = observation
    rows = frappe.get_all(
        "Scouting Alert", filters=filters,
        fields=["name", "observation", "kind", "iso_week", "band", "action", "value", "sections_scouted",
                "section_label", "section_row", "section_col", "status"],
        limit_page_length=0,
    )
    rows.sort(key=lambda r: (r.band != "High", -(r.sections_scouted or 0), r.observation or ""))
    return [
        {"name": r.name, "observation": r.observation, "kind": (r.kind or "Pest").lower(), "week": r.iso_week,
         "band": r.band, "action": r.action, "peak": r.value, "trees": r.sections_scouted,
         "label": r.section_label, "status": r.status}
        for r in rows
    ]


def tree_bands(crop, observation) -> dict | None:
    """``{moderate, high}`` per-tree Count bands of a pest, or None when it has none."""
    for obs, spec in tree_keys(crop):
        if obs == observation:
            return {"moderate": spec.get("mod") or None, "high": spec.get("high") or None}
    return None
