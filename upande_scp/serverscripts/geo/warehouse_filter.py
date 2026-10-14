"""Shared greenhouse-name filter — same rules the Application Floor Plan
page already enforces, surfaced here so every consumer (Heatmaps, Trends,
the React Dashboard pickers) sees a consistent farm/greenhouse list.

The contract:

  * Greenhouse name must contain one of the allowed farms (Spray Plan
    Settings → ``allowed_farms``).
  * Greenhouse name must match the GH-number pattern — ``GH`` followed
    optionally by a number. Tunnels, CSU phases, side rooms etc. don't
    match.
  * Greenhouse name must not contain any of the exclude keywords (Spray
    Plan Settings → ``exclude_keywords`` — e.g. ``tunnel``, ``phase``,
    ``ipm``, ``wetland``, ``csu``).
  * Greenhouse must have a parent farm assigned (``custom_farm``
    populated). Orphans get dropped — there is no policy for what farm
    they belong to.

The Scouting and Crop Protection Settings doctype is the single source of truth for the
``allowed_farms`` and ``exclude_keywords`` lists; the regex is enforced
in code because it's a structural invariant ("a greenhouse is named GH
something") rather than a per-tenant preference.
"""

import re

import frappe


_GH_PATTERN = re.compile(r"\bgh(?:\s*\d+)?\b")
_NUM_PATTERN = re.compile(r"(\d+)\s*(?:-\s*KR)?$")


def load_settings() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Read allowed farms + exclude keywords from Scouting and Crop Protection Settings.

    Returns ``(allowed_farm_names, exclude_keywords_lowercased)``.
    """
    farms = frappe.get_all(
        "Spray Plan Allowed Farm",
        filters={"parenttype": "Scouting and Crop Protection Settings"},
        pluck="farm",
    )
    keywords = frappe.get_all(
        "Spray Plan Exclude Keyword",
        filters={"parenttype": "Scouting and Crop Protection Settings"},
        pluck="keyword",
    )
    allowed = tuple(f for f in farms if f)
    exclude = tuple((k or "").lower() for k in keywords if k)
    return allowed, exclude


def is_greenhouse_allowed(
    name: str,
    allowed_lower: tuple[str, ...],
    exclude_lower: tuple[str, ...],
    *,
    has_farm: bool = True,
) -> bool:
    """Return True if ``name`` represents a real, scout-able greenhouse.

    Args:
        name:            The Warehouse ``name`` to test (case-insensitive
                         match against ``allowed_lower`` + ``exclude_lower``).
        allowed_lower:   Lowercased farm names that must appear somewhere
                         in the greenhouse name.
        exclude_lower:   Lowercased keywords that disqualify the name if
                         found anywhere.
        has_farm:        Whether the greenhouse has a non-empty
                         ``custom_farm`` link. Orphans drop out.
    """
    if not has_farm:
        return False
    if not allowed_lower:
        return False
    lname = (name or "").lower()
    if not any(farm in lname for farm in allowed_lower):
        return False
    if not _GH_PATTERN.search(lname):
        return False
    if any(kw in lname for kw in exclude_lower):
        return False
    return True


def gh_sort_key(name: str, allowed_lower: tuple[str, ...]):
    """Tuple suitable for ``sorted(..., key=...)``: groups by farm prefix,
    then by greenhouse number, then lexicographically for ties."""
    lname = (name or "").lower()
    farm_prefix = ""
    for farm in allowed_lower:
        if farm in lname:
            farm_prefix = farm
            break
    m = _NUM_PATTERN.search(name or "")
    number = int(m.group(1)) if m else 9999
    return (farm_prefix, number, lname)
