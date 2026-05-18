"""Shared validation helpers used by every draft-plan endpoint.

Each function raises `frappe.ValidationError` with a human-readable message
on failure, else returns `None`. They are pure (no DB writes) so they're
also called from `submit_drafts_for_approval` to re-validate at the lock
boundary.
"""
from __future__ import annotations

from typing import Iterable

import frappe
from frappe.utils import add_days, now_datetime


PREVENTIVE_REASON_MIN_CHARS = 20


def derive_cost_center(greenhouse_warehouse: str) -> str:
    """Return the Cost Center whose name matches the greenhouse warehouse name.

    Raises ValidationError if no exact match exists.
    """
    if not greenhouse_warehouse:
        frappe.throw("Greenhouse warehouse is required to derive Cost Center.")
    cc = frappe.db.get_value("Cost Center", greenhouse_warehouse, "name")
    if not cc:
        frappe.throw(
            f"No Cost Center named '{greenhouse_warehouse}' exists. "
            "Create a Cost Center with the same name as the greenhouse warehouse, "
            "then retry.",
            title="Cost Center missing",
        )
    return cc


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
    limits = limits or {}
    lim = limits.get(item_code) or {}
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
    table = "tabPests Scouting Entry" if kind == "pest" else "tabDiseases Scouting Entry"
    field = "pest" if kind == "pest" else "disease"
    rows = frappe.db.sql(
        f"""SELECT DISTINCT child.{field} AS target
            FROM `{table}` AS child
            INNER JOIN `tabScouting Entry` AS parent ON parent.name = child.parent
            WHERE parent.zone LIKE %s
              AND parent.date_of_capture >= %s""",
        (f"{greenhouse}%", cutoff),
        as_dict=True,
    )
    return [r["target"] for r in rows if r.get("target")]
