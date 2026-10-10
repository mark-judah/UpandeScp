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
