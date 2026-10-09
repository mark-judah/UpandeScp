"""Station prevalence with a spatial confidence — the pure measure.

Spec: docs/superpowers/specs/2026-10-09-station-prevalence-design.md §1.

A *station* is a rose Zone or an avocado Orchard Tree. For one greenhouse/block,
one ISO week and one observation:

* ``raw``         = infested / scouted over every scouted station (D1).
* sections        = a fixed 3 × 3 grid from bed (row) order × zone (tree) order
                    within the bed (D3) — no geometry, no setup.
* ``prevalence``  = mean of the section rates over the sections with at least
                    ``MIN_SECTION_N`` scouted stations, so scouting that bunches in
                    one part of the house does not drag the figure toward that part.
* ``margin``      = 1.96 · sqrt(s²/m + p(1−p)/N), clipped to [0, 1].
* ``reliability`` = Good (m ≥ 7 and margin ≤ 0.10) / Fair (m ≥ 4) / Low.

Every percentage leaves this module as a 0–100 float rounded to 1 dp.
No frappe import: this runs under plain pytest.
"""

import math
import re
from datetime import date

GRID = 3
SECTIONS = GRID * GRID
MIN_SECTION_N = 3
Z95 = 1.96
GOOD_MIN_SECTIONS = 7
GOOD_MAX_MARGIN = 0.10
FAIR_MIN_SECTIONS = 4
RELIABILITY = ("Good", "Fair", "Low")
CLUSTERED = "too clustered to judge"
NO_STATIONS = "no stations set up"

#: The figure fields every aggregate payload carries (see ``public``).
PUBLIC_KEYS = (
    "prevalence", "prev", "margin", "sections_scouted", "sections_total",
    "reliability", "reason", "raw", "coverage", "scouted", "stations", "week",
)
EMPTY = {
    "prevalence": None, "prev": None, "margin": None,
    "sections_scouted": 0, "sections_total": SECTIONS,
    "reliability": "Low", "reason": NO_STATIONS,
    "raw": None, "coverage": None, "scouted": 0, "stations": 0, "week": None,
}

# Digits at the very end of a name: "… - Bed 77", "… - Row 10", "…_T38".
# Anchored to the end on purpose — "GH 01 - KR - Bed 7a" must NOT read as 1.
_TRAILING_INT = re.compile(r"(\d+)\s*$")


def station_number(value, name) -> int | None:
    """A station's (or bed's / row's) order number.

    The doctype's own number when it is a positive integer (``Zone.zone``,
    ``Bed.bed``), else the trailing integer of the name (``Orchard Tree.tree`` is
    0 on every tree on kaitet.local, so trees always land here), else ``None`` —
    the station is then placed by name order, never dropped.
    """
    try:
        n = int(str(value).strip()) if value not in (None, "") else 0
    except (TypeError, ValueError):
        n = 0
    if n > 0:
        return n
    m = _TRAILING_INT.search(str(name or ""))
    return int(m.group(1)) if m else None


def _order_key(number, name) -> tuple:
    return (number is None, number if number is not None else 0, str(name or ""))


def grid_positions(stations) -> dict:
    """``{station_name: (row, col)}`` for one greenhouse/block (spec D3).

    ``stations`` yields ``{"name", "group", "group_no", "no"}``: ``group`` is the
    bed (rose) or row (avocado) the station sits in, ``group_no`` / ``no`` their
    order numbers (``None`` = unparsable → name order). Groups are ranked ``b`` of
    ``B``; a station is ranked ``z`` of ``Z_b`` inside its group; its section is
    ``(floor(3·b/B), floor(3·z/Z_b))``. Fewer than 3 groups, or a group of 1–2
    stations, still maps every station; the unused sections stay empty.
    """
    groups: dict = {}
    group_no: dict = {}
    for s in stations:
        g = s.get("group") or ""
        groups.setdefault(g, []).append(s)
        group_no.setdefault(g, s.get("group_no"))
    ordered = sorted(groups, key=lambda g: _order_key(group_no[g], g))
    n_groups = len(ordered)
    out: dict = {}
    for b, g in enumerate(ordered):
        row = (GRID * b) // n_groups
        members = sorted(groups[g], key=lambda s: _order_key(s.get("no"), s["name"]))
        size = len(members)
        for z, s in enumerate(members):
            out[s["name"]] = (row, (GRID * z) // size)
    return out


def section_counts(grid: dict, stations) -> list:
    """How many of ``stations`` fall in each section, row-major (9 numbers).
    Stations missing from the grid are not counted."""
    counts = [0] * SECTIONS
    for name in stations:
        pos = grid.get(name)
        if pos is not None:
            counts[pos[0] * GRID + pos[1]] += 1
    return counts


def _pct(fraction):
    return None if fraction is None else round(fraction * 100, 1)


def reliability(m: int, margin) -> str:
    """Good if m ≥ 7 and margin ≤ 0.10; Fair if m ≥ 4; else Low. ``margin`` is a
    0–1 fraction; ``None`` (too clustered) can never be Good."""
    if m >= GOOD_MIN_SECTIONS and margin is not None and margin <= GOOD_MAX_MARGIN:
        return "Good"
    if m >= FAIR_MIN_SECTIONS:
        return "Fair"
    return "Low"


def figures(grid: dict, scouted, infested, scouted_counts=None):
    """The figures for one greenhouse/block, one ISO week, one observation.

    ``scouted``  — stations with at least one Scouting Entry that week.
    ``infested`` — stations where an entry that week records the observation;
                   anything outside ``scouted`` is ignored.
    ``scouted_counts`` — ``section_counts(grid, scouted)`` when the caller already
                   has it (it is the same for every observation of the week).

    Returns ``None`` when nothing was scouted (the week is omitted, not 0%), and a
    "no stations set up" shape when the house has no Zone / Orchard Tree rows.
    When no section reaches ``MIN_SECTION_N`` scouted stations (m = 0) the only
    estimate left is ``raw``, which is reported with no margin.
    """
    scouted = set(scouted or ())
    if not scouted:
        return None
    infested = set(infested or ()) & scouted
    if not grid:
        return {
            "stations": 0, "scouted": len(scouted), "infested": len(infested),
            "coverage": None, "raw": None, "prevalence": None, "margin": None,
            "sections_scouted": 0, "sections_total": SECTIONS,
            "reliability": "Low", "reason": NO_STATIONS, "sections": [],
        }
    counts = scouted_counts if scouted_counts is not None else section_counts(grid, scouted)
    hits = section_counts(grid, infested)
    sections, rates, n_total = [], [], 0
    for j in range(SECTIONS):
        n, x = counts[j], hits[j]
        pct = None
        if n >= MIN_SECTION_N:
            rates.append(x / n)
            n_total += n
            pct = _pct(x / n)
        sections.append({"row": j // GRID, "col": j % GRID, "scouted": n, "infested": x, "pct": pct})
    m = len(rates)
    raw = len(infested) / len(scouted)
    p = sum(rates) / m if m else raw
    margin = None
    if m >= 2:
        s2 = sum((q - p) ** 2 for q in rates) / (m - 1)
        margin = min(1.0, max(0.0, Z95 * math.sqrt(s2 / m + p * (1 - p) / n_total)))
    return {
        "stations": len(grid),
        "scouted": len(scouted),
        "infested": len(infested),
        "coverage": _pct(sum(counts) / len(grid)),
        "raw": _pct(raw),
        "prevalence": _pct(p),
        "margin": _pct(margin),
        "sections_scouted": m,
        "sections_total": SECTIONS,
        "reliability": reliability(m, margin),
        "reason": CLUSTERED if m < 2 else None,
        "sections": sections,
    }


def combine(figs):
    """Scope-wide figures from per-house ones (several greenhouses / blocks).

    Prevalence is the station-weighted mean of the houses' adjusted prevalence
    ("how much of the farm"). The margin is the weighted houses' margins added in
    quadrature — unknown (``None``) as soon as one house is too clustered to judge.
    Reliability is the worst house's. Houses without figures are skipped.
    """
    figs = [f for f in (figs or []) if f and f.get("prevalence") is not None and f.get("stations")]
    if not figs:
        return None
    weight = sum(f["stations"] for f in figs)
    scouted = sum(f.get("scouted") or 0 for f in figs)
    infested = sum(f.get("infested") or 0 for f in figs)
    in_grid = sum((f.get("coverage") or 0) * f["stations"] / 100 for f in figs)
    p = sum(f["stations"] * f["prevalence"] for f in figs) / weight
    if any(f.get("margin") is None for f in figs):
        margin = None
    else:
        margin = math.sqrt(sum((f["stations"] * f["margin"]) ** 2 for f in figs)) / weight
    worst = max(RELIABILITY.index(f.get("reliability") or "Low") for f in figs)
    return {
        "stations": weight,
        "scouted": scouted,
        "infested": infested,
        "coverage": round(in_grid / weight * 100, 1),
        "raw": round(infested / scouted * 100, 1) if scouted else None,
        "prevalence": round(p, 1),
        "margin": None if margin is None else round(margin, 1),
        "sections_scouted": sum(f.get("sections_scouted") or 0 for f in figs),
        "sections_total": sum(f.get("sections_total") or SECTIONS for f in figs),
        "reliability": RELIABILITY[worst],
        "reason": CLUSTERED if margin is None else None,
        "houses": len(figs),
        "sections": [],
    }


def public(fig) -> dict:
    """The figure fields a payload row carries; ``EMPTY`` when there are none."""
    if not fig:
        return dict(EMPTY)
    return {k: fig.get(k) for k in PUBLIC_KEYS}


def yearweek_label(value) -> str:
    """MariaDB ``YEARWEEK(d, 3)`` (e.g. 203253) → ``"2032-W53"``, the label
    ``_trends.week_key`` produces. ``""`` for anything unreadable."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return ""
    year, week = divmod(v, 100)
    if year <= 0 or not 1 <= week <= 53:
        return ""
    return f"{year:04d}-W{week:02d}"


def week_monday(label: str) -> str:
    """``"2032-W53"`` → ``"2032-12-27"`` (the ISO Monday, as YYYY-MM-DD)."""
    year, week = label.split("-W")
    return date.fromisocalendar(int(year), int(week), 1).isoformat()


def latest_and_previous(window_weeks, all_weeks) -> tuple:
    """Spec D4: the latest week with scouting inside the window, and the most
    recent scouted week before it (which may lie before the window)."""
    window = sorted(set(window_weeks or ()))
    if not window:
        return None, None
    latest = window[-1]
    earlier = sorted(w for w in set(all_weeks or ()) if w < latest)
    return latest, (earlier[-1] if earlier else None)
