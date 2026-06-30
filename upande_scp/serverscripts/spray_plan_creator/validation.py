"""Shared validation helpers used by every draft-plan endpoint.

Each function raises `frappe.ValidationError` with a human-readable message
on failure, else returns `None`. They are pure (no DB writes) so they're
also called from `submit_drafts_for_approval` to re-validate at the lock
boundary.
"""
from __future__ import annotations

import re
from typing import Iterable

import frappe
from frappe.utils import add_days, now_datetime


PREVENTIVE_REASON_MIN_CHARS = 20

# Normalisation key for fuzzy cost-center matching: lower-case, strip every
# whitespace character, then drop leading zeros from any digit run that
# follows a non-digit so "Simotwo GH 07 - KR" collapses onto "Simotwo GH7
# - KR". `\b0+(\d)` does NOT work here because `\b` requires a word/non-word
# transition and both letter and digit are word characters — use a negative
# lookbehind for a digit instead. Trailing zeros (e.g. "GH10") are
# preserved because the preceding char IS a digit.
_LEADING_ZERO_RE = re.compile(r"(?<!\d)0+(\d)")
# Collapse a trailing repeated hyphen-token like "-kr-kr" → "-kr" so
# Cost Centers with an accidentally-duplicated suffix (e.g.
# "Kapkolia GH18 - KR - KR") still match their warehouse counterpart.
# Anchored at end-of-string to keep mid-name dashes untouched.
_TRAILING_DUP_SUFFIX_RE = re.compile(r"(-[a-z0-9]+)(?:\1)+$")


def _normalise_name_key(name: str) -> str:
    if not name:
        return ""
    lowered = (name or "").lower()
    no_space = re.sub(r"\s+", "", lowered)
    no_zeros = _LEADING_ZERO_RE.sub(r"\1", no_space)
    return _TRAILING_DUP_SUFFIX_RE.sub(r"\1", no_zeros)


# Greenhouse-number extraction for the mona naming convention, where the
# warehouse ("Main GH 10 - MFK") and its Cost Center ("GH010 - MFK") share
# only the greenhouse number — the farm prefix is dropped and the number is
# zero-padded, so the whitespace/zero-normalised keys don't line up. We pull
# the integer after "GH" and match on that. ``0*(\d+)`` collapses the padding
# ("010" -> 10) and int() comparison avoids "GH 10" matching "GH 100". The
# ``(?<![a-z])`` guard stops the "gh" inside words like "High"/"Weighbridge"
# from being read as a greenhouse token.
_GH_NUMBER_RE = re.compile(r"(?<![a-z])gh\s*0*(\d+)", re.IGNORECASE)


def _greenhouse_number(name: str) -> int | None:
    m = _GH_NUMBER_RE.search(name or "")
    return int(m.group(1)) if m else None


def match_cost_center(greenhouse_warehouse: str) -> str | None:
    """Return the Cost Center for a greenhouse warehouse, or None.

    Resolution order:
      1. ``Warehouse.custom_cost_center`` — explicit, authoritative.
      2. Exact-name match against ``Cost Center`` (legacy).
      3. Whitespace-, leading-zero-, and case-insensitive name match (legacy).
      4. Greenhouse-number match — mona convention, where warehouse
         "Main GH 10 - MFK" maps to Cost Center "GH010 - MFK". Only used when
         it resolves to exactly one Cost Center (ambiguity returns None).

    The fallbacks exist so warehouses where the new field hasn't been set
    yet keep resolving via the name convention. Set ``custom_cost_center``
    on the warehouse to opt out of the fallbacks.
    """
    if not greenhouse_warehouse:
        return None
    explicit = frappe.db.get_value(
        "Warehouse", greenhouse_warehouse, "custom_cost_center"
    )
    if explicit:
        return explicit
    cc = frappe.db.get_value("Cost Center", greenhouse_warehouse, "name")
    if cc:
        return cc
    target_key = _normalise_name_key(greenhouse_warehouse)
    if not target_key:
        return None
    candidates = frappe.get_all(
        "Cost Center", filters={"disabled": 0}, pluck="name"
    )
    for candidate in candidates:
        if _normalise_name_key(candidate) == target_key:
            return candidate
    # Mona greenhouse-number fallback (e.g. "Main GH 10 - MFK" -> "GH010 - MFK").
    gh_num = _greenhouse_number(greenhouse_warehouse)
    if gh_num is not None:
        gh_matches = [c for c in candidates if _greenhouse_number(c) == gh_num]
        if len(gh_matches) == 1:
            return gh_matches[0]
    return None


def derive_cost_center(greenhouse_warehouse: str) -> str:
    """Return the Cost Center whose name matches the greenhouse warehouse name.

    Throws ValidationError when no match exists. See ``match_cost_center``
    for the non-throwing equivalent used by previews.
    """
    if not greenhouse_warehouse:
        frappe.throw("Greenhouse warehouse is required to derive Cost Center.")
    cc = match_cost_center(greenhouse_warehouse)
    if cc:
        return cc
    frappe.throw(
        f"No Cost Center named '{greenhouse_warehouse}' exists "
        "(checked exact match and whitespace-tolerant fallback). "
        "Create a Cost Center with the same name as the greenhouse warehouse, "
        "then retry.",
        title="Cost Center missing",
    )


@frappe.whitelist()
def list_cost_centers(company: str | None = None) -> list[dict]:
    """Return all active, non-group Cost Centers — used by the application
    floor-plan pages to drive the override picker.

    Optionally filter to a single company. Output rows are
    ``{name, company, custom_farm}`` so the UI can group/badge them.
    """
    filters: dict = {"disabled": 0, "is_group": 0}
    if company:
        filters["company"] = company
    return frappe.get_all(
        "Cost Center",
        filters=filters,
        fields=["name", "company", "custom_farm"],
        order_by="name asc",
        limit_page_length=0,
    )


@frappe.whitelist()
def resolve_warehouse_cost_center(warehouse: str) -> dict:
    """Lazy lookup: return the Cost Center for `warehouse` via the same
    resolver chain the React page uses.

    Used by the www `new_application_floor_plan` page on greenhouse-select so
    the upfront page-load cost of resolving every warehouse is avoided.
    Returns ``{"cost_center": str|None, "source": "explicit"|"exact"|"fuzzy"|None}``
    so the UI can label why a value was chosen if needed.
    """
    if not warehouse:
        return {"cost_center": None, "source": None}
    explicit = frappe.db.get_value("Warehouse", warehouse, "custom_cost_center")
    if explicit:
        return {"cost_center": explicit, "source": "explicit"}
    if frappe.db.exists("Cost Center", {"name": warehouse, "disabled": 0}):
        return {"cost_center": warehouse, "source": "exact"}
    target_key = _normalise_name_key(warehouse)
    if not target_key:
        return {"cost_center": None, "source": None}
    for candidate in frappe.get_all(
        "Cost Center", filters={"disabled": 0}, pluck="name"
    ):
        if _normalise_name_key(candidate) == target_key:
            return {"cost_center": candidate, "source": "fuzzy"}
    return {"cost_center": None, "source": None}


def validate_preventive_reason(classification: str, reason: str | None) -> None:
    if classification != "Preventive":
        return
    if not reason or len(reason.strip()) < PREVENTIVE_REASON_MIN_CHARS:
        frappe.throw(
            f"Preventive spray plans require a reason of at least "
            f"{PREVENTIVE_REASON_MIN_CHARS} characters.",
            title="Preventive Reason required",
        )


def validate_rate_in_limits(
    item_code: str, rate: float | None, limits: dict | None
) -> None:
    if not item_code or not rate or rate <= 0:
        return
    lim = (limits or {}).get(item_code)
    if lim is None:
        # Not in the caller's prefetched map → resolve from the Chemical master
        # (falls back to Item custom fields). This is the rate-limit "validator"
        # reading the Chemical list, not the Item list.
        from upande_scp.serverscripts import chemical_meta
        lower, upper = chemical_meta.rate_limits(item_code)
    else:
        lower = lim.get("lower")
        upper = lim.get("upper")
    if lower is not None and rate < lower:
        frappe.throw(
            f"{item_code}: rate {rate} is below the configured lower limit of {lower}.",
            title="Rate out of range",
        )
    if upper is not None and rate > upper:
        frappe.throw(
            f"{item_code}: rate {rate} is above the configured upper limit of {upper}.",
            title="Rate out of range",
        )


def validate_targets_in_scope(
    classification: str,
    targets: Iterable[str],
    *,
    greenhouse: str | None = None,
    days: int = 60,
) -> None:
    targets = [t for t in (targets or []) if t]
    if not targets:
        frappe.throw("At least one target is required.")

    if classification == "Curative":
        # Every target must appear in a Scouting Entry for this greenhouse in
        # the last `days` days. Greenhouse name is the warehouse name; the
        # parent Scouting Entry's `zone` field is a string that starts with
        # the greenhouse name (e.g. "Kaptumbo GH 12 - Bed 5").
        cutoff = add_days(now_datetime(), -days)
        observed_pests = set(_observed_targets(greenhouse, cutoff, kind="pest"))
        observed_diseases = set(_observed_targets(greenhouse, cutoff, kind="disease"))
        observed = observed_pests | observed_diseases
        unknown = [t for t in targets if t not in observed]
        if unknown:
            frappe.throw(
                f"These targets have not been observed in {greenhouse} in the last "
                f"{days} days: {', '.join(unknown)}.",
                title="Targets not observed",
            )
    else:
        # Preventive: each target must exist in the Pest or Plant Disease catalog.
        for t in targets:
            if not (frappe.db.exists("Pest", t) or frappe.db.exists("Plant Disease", t)):
                frappe.throw(
                    f"Target '{t}' is not in the Pest or Plant Disease catalog.",
                    title="Unknown target",
                )


def _observed_targets(greenhouse: str | None, cutoff, kind: str) -> Iterable[str]:
    if not greenhouse:
        return []
    greenhouse = greenhouse.strip()
    table = "tabPests Scouting Entry" if kind == "pest" else "tabDiseases Scouting Entry"
    field = "pest" if kind == "pest" else "disease"
    # mona imported zone names wrapped in literal double-quotes
    # (e.g. `"Main GH 08 - MFK - Bed 131 - Zone 8"`), so a plain
    # `zone LIKE 'Main GH 08 - MFK%'` prefix never matched and curative targets
    # looked "not observed" even with same-day scouting. Strip the wrapping
    # quotes before matching — mirrors the quote handling already done at the
    # geometry / heatmap / diagnose boundaries. TRIM is a no-op on unquoted
    # sites, so this stays correct everywhere.
    rows = frappe.db.sql(
        f"""SELECT DISTINCT child.{field} AS target
            FROM `{table}` AS child
            INNER JOIN `tabScouting Entry` AS parent ON parent.name = child.parent
            WHERE TRIM(BOTH '"' FROM parent.zone) LIKE %s
              AND parent.date_of_capture >= %s""",
        (f"{greenhouse}%", cutoff),
        as_dict=True,
    )
    return [r["target"] for r in rows if r.get("target")]
