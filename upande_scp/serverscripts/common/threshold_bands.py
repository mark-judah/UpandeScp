"""Threshold bands, measures and actions — the pure rules.

Spec: docs/superpowers/specs/2026-10-10-thresholds-and-actions-design.md
(D1 measure, D3 bands → action, D5 escalation). No frappe import: runs under
plain pytest.

* A Pest/Disease Filter row is measured as a **Percentage** (piece 2's adjusted
  prevalence, 0–100) or a **Count** (average count per scouted station). Count
  needs a pest stage that scouts record as a number.
* Bands are Low < Moderate < High, strictly ascending over the bands that are
  set. All three at zero = unconfigured. Misordered bands judge nothing.
* Moderate → Alarming; High → Spray advised, or Scout first when the figure's
  reliability is Low; Low → no action.
* A new notification only when the action escalates:
  Alarming < Scout first < Spray advised.
"""

import math

PERCENTAGE = "Percentage"
COUNT = "Count"
MEASURES = (PERCENTAGE, COUNT)

ALARMING = "Alarming"
SPRAY_ADVISED = "Spray advised"
SCOUT_FIRST = "Scout first"
ACTIONS = (ALARMING, SPRAY_ADVISED, SCOUT_FIRST)
#: Escalation order (D5).
ACTION_RANK = {ALARMING: 1, SCOUT_FIRST: 2, SPRAY_ADVISED: 3}

#: Scouting Alert.band for the two bands that raise an alert.
BAND_LABEL = {"moderate": "Moderate", "high": "High"}


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def is_configured(low, moderate, high) -> bool:
    return any(_num(v) > 0 for v in (low, moderate, high))


def bands_ascending(low, moderate, high) -> bool:
    """True when the bands that are set rise strictly (D3). All-zero is
    unconfigured and allowed; a negative band never is."""
    values = [_num(low), _num(moderate), _num(high)]
    if any(v < 0 for v in values):
        return False
    set_ = [v for v in values if v > 0]
    return all(a < b for a, b in zip(set_, set_[1:]))


def band_of(value, low, moderate, high):
    """``"high" | "moderate" | "low"`` for a figure, ``""`` when judged and below
    every band, ``None`` when there is no figure or the bands are unset or
    misordered. Inclusive: a value exactly on a threshold is in that band."""
    if value is None or not is_configured(low, moderate, high):
        return None
    if not bands_ascending(low, moderate, high):
        return None
    v = float(value)
    for key, limit in (("high", high), ("moderate", moderate), ("low", low)):
        if _num(limit) > 0 and v >= _num(limit):
            return key
    return ""


def action_for(band, reliability):
    """D3: Moderate → Alarming; High → Spray advised, or Scout first when the
    figure's reliability is Low (or unknown); anything else → None."""
    if band == "moderate":
        return ALARMING
    if band == "high":
        return SCOUT_FIRST if (reliability or "Low") == "Low" else SPRAY_ADVISED
    return None


def escalates(previous, new) -> bool:
    """D5: notify only when ``new`` outranks what was already notified."""
    if new not in ACTION_RANK:
        return False
    return ACTION_RANK[new] > ACTION_RANK.get(previous or "", 0)


def effective_measure(row_measure, reading_type=None) -> str:
    """The measure a figure is judged in. ``reading_type`` None means the row's
    own all-stage figure. Under a Count row, a Checkbox or Range stage is judged
    as a Percentage: scouts record a tick there, not a number."""
    if row_measure != COUNT:
        return PERCENTAGE
    if reading_type is None:
        return COUNT
    return COUNT if reading_type == COUNT else PERCENTAGE


def count_allowed(kind, reading_types) -> bool:
    """D1: Count only for a pest with at least one stage recorded as a number."""
    return kind == "pest" and any(rt == COUNT for rt in (reading_types or ()))


def unit_label(measure, station="zone") -> str:
    """``%`` for a Percentage; ``per zone`` / ``per tree`` for a Count."""
    return "%" if measure != COUNT else f"per {station or 'zone'}"


def format_value(value, unit) -> str:
    """``33.3%`` / ``1.2 per zone`` / ``—``."""
    if value is None:
        return "—"
    return f"{value}%" if unit == "%" else f"{value} {unit}"


# ── hot spots (spec 2026-10-10-hot-spots, H1–H5) ──────────────────────────

HOUSE = "House"
HOT_SPOT = "Hot spot"
ALERT_TYPES = (HOUSE, HOT_SPOT)
#: H2: a section needs at least this many scouted stations to be a hot spot.
HOTSPOT_MIN_N = 5
#: A section's reliability is Fair from HOTSPOT_MIN_N stations, Good from this.
HOTSPOT_GOOD_N = 10
#: Band order for comparing a section with its house ("" = judged, below Low).
BAND_RANK = {"": 0, "low": 1, "moderate": 2, "high": 3}
#: Sort order across both alert types: a hot spot sits with Alarming. Not an
#: escalation ladder — a hot spot escalates by band (``band_escalates``).
ALERT_RANK = {**ACTION_RANK, HOT_SPOT: ACTION_RANK[ALARMING]}
_STORED_BAND_RANK = {"Moderate": 1, "High": 2}
_ROW_WORDS = ("first", "middle", "last")
_COL_WORDS = ("front", "middle", "back")


def section_value(section, measure):
    """A section's figure in the row's measure: ``avg`` (count per scouted
    station) for a Count, ``pct`` for a Percentage. None below 3 stations."""
    return section.get("avg") if measure == COUNT else section.get("pct")


def section_reliability(n) -> str:
    """Spec §3: Good if n ≥ 10, Fair if n ≥ 5, else Low."""
    n = int(n or 0)
    if n >= HOTSPOT_GOOD_N:
        return "Good"
    if n >= HOTSPOT_MIN_N:
        return "Fair"
    return "Low"


#: z for the Wilson 95 % lower bound a Percentage section is judged on.
WILSON_Z = 1.96


def wilson_lower(x, n, z=WILSON_Z):
    """The Wilson score interval's lower bound for ``x`` infested of ``n``
    scouted, as a 0–100 figure rounded to 1 dp; None without stations.
    ``(p + z²/2n − z·sqrt(p(1−p)/n + z²/4n²)) / (1 + z²/n)``."""
    try:
        n, x = int(n or 0), int(x or 0)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    x = min(max(x, 0), n)
    p = x / n
    z2 = z * z
    centre = p + z2 / (2 * n)
    spread = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    return round(max(0.0, (centre - spread) / (1 + z2 / n)) * 100, 1)


def _section_infested(section):
    """The section's infested count; derived from its pct when a caller passes
    only the rate."""
    if section.get("infested") is not None:
        return section["infested"]
    pct, n = section.get("pct"), int(section.get("scouted") or 0)
    return round(float(pct) * n / 100) if pct is not None else 0


def section_readings(house_value, sections, bands, measure) -> list:
    """Every section with a figure, judged against its house (H2):
    ``{"row", "col", "value", "lower", "scouted", "band", "reliability", "hot"}``.

    ``hot`` when the section's band is at least Moderate, higher than the
    house's band, and the section has ≥ HOTSPOT_MIN_N scouted stations. For a
    **Percentage** the band is that of the section's Wilson 95 % lower bound
    (``lower``, from infested / scouted) — a 5-station section at 3 of 5 is
    noise, 5 of 5 is not (final review, 2026-10-10); ``value`` stays the
    observed pct. A **Count** is judged on its average (``lower`` None).
    ``bands`` is a band spec (``{"low", "mod", "high"}``, as ``band_spec``
    returns). Nothing when the house has no figure or the bands are unset or
    misordered; a section without a figure (< 3 stations) is skipped — it is
    no reading, so it neither raises nor resolves."""
    low, mod, high = bands.get("low"), bands.get("mod"), bands.get("high")
    house_band = band_of(house_value, low, mod, high)
    if house_band is None:
        return []
    house_rank = BAND_RANK.get(house_band, 0)
    out = []
    for s in sections or ():
        value = section_value(s, measure)
        if value is None:
            continue
        n = int(s.get("scouted") or 0)
        lower = None if measure == COUNT else wilson_lower(_section_infested(s), n)
        band = band_of(value if measure == COUNT else lower, low, mod, high) or ""
        rank = BAND_RANK.get(band, 0)
        out.append({
            "row": s["row"], "col": s["col"], "value": value, "lower": lower, "scouted": n, "band": band,
            "reliability": section_reliability(n),
            "hot": n >= HOTSPOT_MIN_N and rank >= BAND_RANK["moderate"] and rank > house_rank,
        })
    return out


def hotspots(house_value, sections, bands, measure) -> list:
    """The sections meeting H2 (see ``section_readings``)."""
    return [r for r in section_readings(house_value, sections, bands, measure) if r["hot"]]


def band_escalates(previous, new) -> bool:
    """H5: a hot spot is announced again only when its section's band rises
    (stored labels ``Moderate`` → ``High``)."""
    if new not in _STORED_BAND_RANK:
        return False
    return _STORED_BAND_RANK[new] > _STORED_BAND_RANK.get(previous or "", 0)


def section_unit(station) -> str:
    """``row`` for a crop scouted on trees (avocado blocks), else ``bed``."""
    return "row" if station == "tree" else "bed"


def section_label(row, col, unit="bed") -> str:
    """``first beds · front`` / ``last rows · back`` — rows of the 3 × 3 grid are
    thirds of the beds (rows) in order, columns the front / middle / back."""
    try:
        if not (0 <= int(row) <= 2 and 0 <= int(col) <= 2):
            return ""
        return f"{_ROW_WORDS[int(row)]} {unit}s · {_COL_WORDS[int(col)]}"
    except (IndexError, TypeError, ValueError):
        return ""
