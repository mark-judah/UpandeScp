"""Raw-SQL scouting placed by rank, for the spread and pins tests (piece 3c).

Same contract as prevalence_fixture: callers roll back in tearDown. Weeks
2031-W24…W32 (2031-06-09 → 2031-08-10) — no other module seeds them, and
kaitet.local has no real scouting in 2031.
"""

from datetime import date

from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import prevalence_fixture as PF

AVOCADO_PEST = "Fruit fly (Ceratitis)"   # Avocado Pest Filter only


def monday(week: int) -> str:
    """The Monday of 2031-W<week>, YYYY-MM-DD."""
    return date.fromisocalendar(2031, week, 1).isoformat()


def by_rank(warehouse) -> dict:
    """``{(group rank, rank in group): station}`` for one house."""
    return {tuple(pos): st for st, pos in R._load_ranks([warehouse])[warehouse].items()}


def rect(r0, c0, h, w) -> list:
    return [(r, c) for r in range(r0, r0 + h) for c in range(c0, c0 + w)]


def section_stations(warehouse, row, col, n) -> list:
    """The first ``n`` stations (by name) of one 3 × 3 section."""
    return PF.stations_by_section(R._load_grid(warehouse))[(row, col)][:n]


def seed(warehouse, day, stations, *, crop="Rose", infested=None, pest="Thrips", disease=None,
         stage="Adult", block=False) -> list:
    """One entry per station on ``day``. The ``infested`` ones (every station
    when None) carry ``pest`` at ``stage`` and ``disease``; the rest are clean."""
    hit = set(stations if infested is None else infested)
    names = []
    for st in stations:
        where = {"block": warehouse, "tree": st} if block else {"greenhouse": warehouse, "zone": st}
        on = st in hit
        names.append(PF.insert_station_entry(
            date=day, crop=crop, pests=[pest] if on and pest else [],
            diseases=[disease] if on and disease else [], pest_stage=stage, **where,
        ))
    return names


def seed_cells(warehouse, day, cells, **kw) -> list:
    """``seed`` on the stations at these (rank, rank) cells, all infested."""
    inv = by_rank(warehouse)
    return seed(warehouse, day, [inv[c] for c in cells], **kw)
