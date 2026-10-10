"""Data quality & scouting KPIs (roadmap item 7) — the pure side.

"Can we trust the scouting data, and which scouts / houses need attention?"
Spec: docs/superpowers/specs/2026-10-10-data-quality-design.md.

Thresholds are constants here, not settings (Q5). ``Fold`` reduces the entry
rows ``dashboard_aggregates/_quality.py`` streams one capture date at a time
into per-house and per-scout figures; ``flag_rows`` turns those into the ranked
"Needs attention" list (Q4). Nothing here touches the database.

An entry row is ``(scout, date, house, station, bed, seconds since midnight,
sync delay s | None, fix-to-zone distance m | None, zone buffer m | None,
nothing found 0/1)`` — distance is None when the entry has no Scouting Entry
Metadata row; the sync delay is None for entries the bulk load stamped (Q3).
"""

import math

#: A move between stations by the same scout faster than this is "too fast"
#: (Q3, clarified: only zone-to-zone moves count — several observations on one
#: zone are logged as several entries seconds apart, and that is normal).
TOO_FAST_SECONDS = 5
#: Sync delay is only meaningful for entries created on or after this date —
#: earlier rows were bulk-loaded, so ``creation`` says nothing about the phone.
SYNC_DELAY_FROM = "2026-09-02"

# ── flags (Q4) ──────────────────────────────────────────────────────────────
MAP_OFFSET_MEDIAN_M = 20.0     # house median fix-to-zone distance above this …
MIN_FIXES = 50                 # … over at least this many metadata fixes
THIN_COVERAGE_PCT = 30.0       # house: stations scouted in its latest week below this
TOO_FAST_PCT = 20.0            # scout: zone-to-zone moves < 5 s above this
NOTHING_FOUND_EXCESS = 25.0    # scout: nothing-found share this many points over the scope's …
NOTHING_FOUND_MIN_ENTRIES = 100  # … with at least this many entries
OFF_ZONE_EXCESS = 25.0         # scout: off-zone share this many points over their houses' (≥ MIN_FIXES)
ZONE_MAP_SUSPECT_PCT = 30.0    # scope: off-zone share above this → "zone map needs checking"
DUPLICATE_PCT = 2.0            # scout: duplicate entries above this
METADATA_MIN_PCT = 50.0        # house: below this GPS figures are incomplete (greyed)

#: Tie-break order when two flags score the same.
KINDS = ("map_offset", "thin_coverage", "too_fast", "nothing_found", "off_zone",
         "duplicates", "metadata_gap")


def _pct(n, d, digits=1):
    return round(100.0 * n / d, digits) if d else None


def too_fast_moves(entries) -> tuple:
    """``(fast, moves)`` for one scout-day of ``(seconds, station)`` entries.

    In time order, a *move* is an entry on a different station from the entry
    before it; it is *fast* when it came < ``TOO_FAST_SECONDS`` after that entry.
    Consecutive entries on the same station (one per observation) are not moves.
    Entries without a time or a station are skipped."""
    seq = sorted((t, st) for t, st in entries if t is not None and st)
    fast = moves = 0
    for (t0, s0), (t1, s1) in zip(seq, seq[1:]):
        if s1 != s0:
            moves += 1
            if t1 - t0 < TOO_FAST_SECONDS:
                fast += 1
    return fast, moves


def too_fast_share(entries):
    """``too_fast_moves`` as a % of the moves; None when there is no move."""
    fast, moves = too_fast_moves(list(entries))
    return _pct(fast, moves)


def active_hours(times) -> float:
    """First → last capture of one scout-day, in hours."""
    ts = [t for t in times if t is not None]
    return (max(ts) - min(ts)) / 3600.0 if ts else 0.0


def percentile(hist: dict, q: float):
    """Nearest-rank percentile of a ``{value: count}`` histogram; None when empty."""
    total = sum(hist.values())
    if not total:
        return None
    rank = max(1, math.ceil(q * total))
    seen = 0
    for value in sorted(hist):
        seen += hist[value]
        if seen >= rank:
            return value
    return None


class _House:
    __slots__ = ("entries", "scouts", "fixes", "off", "dist", "nothing")

    def __init__(self):
        self.entries = self.fixes = self.off = self.nothing = 0
        self.scouts = set()
        self.dist = {}


class _Scout:
    __slots__ = ("entries", "days", "hours", "timed_entries", "beds", "fast", "moves",
                 "nothing", "fixes", "off", "dupes", "sync", "house_fixes")

    def __init__(self):
        self.entries = self.days = self.timed_entries = self.beds = 0
        self.fast = self.moves = self.nothing = self.fixes = self.off = self.dupes = 0
        self.hours = 0.0
        self.sync = {}
        self.house_fixes = {}  # house -> this scout's fixes there


class Fold:
    """Per-house and per-scout figures over entry rows fed one date at a time."""

    def __init__(self):
        self.houses: dict = {}
        self.scouts: dict = {}

    def add_day(self, rows) -> None:
        """Fold one capture date's entry rows. Gaps, duplicates and beds are
        per scout-day, so every row of a scout's day must arrive in one call."""
        days: dict = {}
        for scout, day, wh, station, bed, tm, delay, dist, buf, nothing in rows:
            wh = wh or ""
            h = self.houses.get(wh)
            if h is None:
                h = self.houses[wh] = _House()
            h.entries += 1
            nothing = 1 if nothing else 0
            h.nothing += nothing
            off = 0
            if dist is not None:
                dist = float(dist)
                off = 1 if dist > float(buf or 0) else 0
                h.fixes += 1
                h.off += off
                key = round(dist, 1)
                h.dist[key] = h.dist.get(key, 0) + 1
            if not scout:
                continue
            h.scouts.add(scout)
            d = days.get((scout, day))
            if d is None:
                d = days[(scout, day)] = ([], {}, set())
            tm = None if tm is None else int(tm)
            d[0].append((tm, (wh, station) if station else None))
            if station and tm is not None:
                # a true double-submit: same station to the second (clarification 1)
                key = (wh, station, tm)
                d[1][key] = d[1].get(key, 0) + 1
            if bed:
                d[2].add((wh, bed))
            s = self.scouts.get(scout)
            if s is None:
                s = self.scouts[scout] = _Scout()
            s.entries += 1
            s.nothing += nothing
            if dist is not None:
                s.fixes += 1
                s.off += off
                s.house_fixes[wh] = s.house_fixes.get(wh, 0) + 1
            if delay is not None:
                minute = max(0, int(delay)) // 60
                s.sync[minute] = s.sync.get(minute, 0) + 1
        for (scout, _day), (entries, stations, beds) in days.items():
            s = self.scouts[scout]
            s.days += 1
            fast, moves = too_fast_moves(entries)
            s.fast += fast
            s.moves += moves
            times = [t for t, _st in entries]
            hours = active_hours(times)
            if hours > 0:
                s.hours += hours
                s.timed_entries += len(times)
            s.beds += len(beds)
            s.dupes += sum(c - 1 for c in stations.values() if c > 1)

    # ── rows ───────────────────────────────────────────────────────────────

    def house_rows(self, coverage: dict) -> list:
        """One row per house; ``coverage`` is ``{house: prevalence figure}``
        (stations, scouted, coverage, sections_scouted, week) for its latest week."""
        out = []
        for wh in sorted(self.houses):
            h = self.houses[wh]
            cov = coverage.get(wh) or {}
            meta = _pct(h.fixes, h.entries)
            out.append({
                "house": wh,
                "week": cov.get("week"),
                "weekPartial": bool(cov.get("partial")),
                "stations": cov.get("stations"),
                "stationsScouted": cov.get("scouted"),
                "coveragePct": cov.get("coverage"),
                "sectionsScouted": cov.get("sections_scouted"),
                "entries": h.entries,
                "scouts": len(h.scouts),
                "nothingFoundPct": _pct(h.nothing, h.entries),
                "fixes": h.fixes,
                "metadataPct": meta,
                "offZonePct": _pct(h.off, h.fixes),
                "medianDistance": percentile(h.dist, 0.5),
                "p90Distance": percentile(h.dist, 0.9),
                "gpsReliable": (meta or 0) >= METADATA_MIN_PCT,
            })
        return out

    def scout_rows(self, names: dict) -> list:
        out = []
        for scout in sorted(self.scouts):
            s = self.scouts[scout]
            median = percentile(s.sync, 0.5)
            base_n = sum(s.house_fixes.values())
            base = sum(n * self.houses[wh].off / self.houses[wh].fixes
                       for wh, n in s.house_fixes.items()) if base_n else 0
            out.append({
                "scout": scout,
                "scoutName": names.get(scout) or scout,
                "entries": s.entries,
                "activeDays": s.days,
                "entriesPerHour": round(s.timed_entries / s.hours, 1) if s.hours else None,
                "bedsPerDay": round(s.beds / s.days, 1) if s.days else None,
                "moves": s.moves,
                "tooFastPct": _pct(s.fast, s.moves),
                "nothingFoundPct": _pct(s.nothing, s.entries),
                "fixes": s.fixes,
                "metadataPct": _pct(s.fixes, s.entries),
                "offZonePct": _pct(s.off, s.fixes),
                "houseOffZonePct": _pct(base, base_n),
                "duplicates": s.dupes,
                "duplicatePct": _pct(s.dupes, s.entries),
                "medianSyncMin": None if median is None else float(median),
                "syncSample": sum(s.sync.values()),
            })
        return out

    def kpis(self, coverage_figs) -> dict:
        """Scope-wide tiles. Coverage is station-weighted over the houses' latest
        weeks; the rest are shares of every entry / fix in the window."""
        entries = sum(h.entries for h in self.houses.values())
        fixes = sum(h.fixes for h in self.houses.values())
        figs = [f for f in coverage_figs if f and f.get("stations") and f.get("coverage") is not None]
        weight = sum(f["stations"] for f in figs)
        cov = sum(f["stations"] * f["coverage"] for f in figs) / weight if weight else None
        off = _pct(sum(h.off for h in self.houses.values()), fixes)
        return {
            "entries": entries,
            "houses": len(self.houses),
            "scouts": len(self.scouts),
            "coveragePct": None if cov is None else round(cov, 1),
            "offZonePct": off,
            "zoneMapSuspect": off is not None and off > ZONE_MAP_SUSPECT_PCT,
            "tooFastPct": _pct(sum(s.fast for s in self.scouts.values()),
                               sum(s.moves for s in self.scouts.values())),
            "metadataPct": _pct(fixes, entries),
            "nothingFoundPct": _pct(sum(h.nothing for h in self.houses.values()), entries),
        }


# ── flags ─────────────────────────────────────────────────────────────────


def _flag(kind, subject, name, label, value, threshold, unit, score, detail):
    return {"kind": kind, "subject": subject, "name": name, "label": label,
            "value": value, "threshold": threshold, "unit": unit,
            "score": round(score, 3), "detail": detail}


def _over(value, line):
    return (value - line) / line


def _under(value, line):
    return (line - value) / line


def flag_rows(houses, scouts, scope_nothing_pct) -> list:
    """The "Needs attention" list (Q4), most urgent first: each flag scores how
    far past its line it sits, relative to the line."""
    out = []
    for h in houses:
        name = h["house"]
        med = h.get("medianDistance")
        if med is not None and med > MAP_OFFSET_MEDIAN_M and (h.get("fixes") or 0) >= MIN_FIXES:
            out.append(_flag("map_offset", "house", name, name, med, MAP_OFFSET_MEDIAN_M, "m",
                             _over(med, MAP_OFFSET_MEDIAN_M),
                             f"median fix {med:g} m from its zone over {h['fixes']} fixes — check the zone map"))
        cov = h.get("coveragePct")
        if cov is not None and cov < THIN_COVERAGE_PCT:
            out.append(_flag("thin_coverage", "house", name, name, cov, THIN_COVERAGE_PCT, "%",
                             _under(cov, THIN_COVERAGE_PCT),
                             f"{cov:g}% of stations scouted in {h.get('week') or 'its latest week'}"
                             + (" (partial week)" if h.get("weekPartial") else "")))
        meta = h.get("metadataPct")
        if meta is not None and meta < METADATA_MIN_PCT:
            out.append(_flag("metadata_gap", "house", name, name, meta, METADATA_MIN_PCT, "%",
                             _under(meta, METADATA_MIN_PCT),
                             f"only {meta:g}% of entries carry GPS detail — GPS figures incomplete"))
    for s in scouts:
        name, label = s["scout"], s.get("scoutName") or s["scout"]
        fast = s.get("tooFastPct")
        if fast is not None and fast > TOO_FAST_PCT:
            out.append(_flag("too_fast", "scout", name, label, fast, TOO_FAST_PCT, "%",
                             _over(fast, TOO_FAST_PCT),
                             f"{fast:g}% of zone-to-zone moves under {TOO_FAST_SECONDS} s"))
        nothing = s.get("nothingFoundPct")
        if (nothing is not None and scope_nothing_pct is not None
                and (s.get("entries") or 0) >= NOTHING_FOUND_MIN_ENTRIES
                and nothing - scope_nothing_pct >= NOTHING_FOUND_EXCESS):
            excess = round(nothing - scope_nothing_pct, 1)
            out.append(_flag("nothing_found", "scout", name, label, nothing,
                             round(scope_nothing_pct + NOTHING_FOUND_EXCESS, 1), "%",
                             _over(excess, NOTHING_FOUND_EXCESS),
                             f"nothing found on {nothing:g}% of entries vs {scope_nothing_pct:g}% across the scope"))
        off, base = s.get("offZonePct"), s.get("houseOffZonePct")
        if (off is not None and base is not None and (s.get("fixes") or 0) >= MIN_FIXES
                and off - base >= OFF_ZONE_EXCESS):
            out.append(_flag("off_zone", "scout", name, label, off, round(base + OFF_ZONE_EXCESS, 1), "%",
                             _over(round(off - base, 1), OFF_ZONE_EXCESS),
                             f"{off:g}% of fixes outside the zone buffer vs {base:g}% in the same houses"))
        dup = s.get("duplicatePct")
        if dup is not None and dup > DUPLICATE_PCT:
            out.append(_flag("duplicates", "scout", name, label, dup, DUPLICATE_PCT, "%",
                             _over(dup, DUPLICATE_PCT),
                             f"{s.get('duplicates', 0)} double-submits (same station, same second)"))
    out.sort(key=lambda f: (-f["score"], KINDS.index(f["kind"]), f["name"]))
    return out
