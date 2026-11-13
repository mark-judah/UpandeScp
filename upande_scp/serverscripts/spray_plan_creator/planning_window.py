"""How far ahead an Application Floor Plan may be planned.

A plan holds its chemicals for ``reservation_window_days`` (default 5), so it may be
dated at most that many days ahead of today (site time). Postponement is a separate
flow and may move a plan later; it does not pass through here.
"""
from __future__ import annotations

import frappe
from frappe.utils import add_days, date_diff, getdate, now_datetime

from .reservations import get_window_days as hold_days


def today():
    return getdate(now_datetime())


def refusal_for(spray_date) -> str | None:
    """Why ``spray_date`` is too far ahead, or None. Blank dates are not this rule's."""
    if not spray_date:
        return None
    d = getdate(spray_date)
    n = hold_days()
    away = date_diff(d, today())
    if away <= n:
        return None
    return (
        f"Chemicals are only held for {n} days, so a plan can be made at most {n} days "
        f"ahead. {d} is {away} days away: plan it on or after {add_days(d, -n)}."
    )


def enforce(spray_date) -> None:
    msg = refusal_for(spray_date)
    if msg:
        frappe.throw(msg, title="Too far ahead")


def refusal_for_submit(name: str) -> str | None:
    """Same rule for a stored draft about to go for approval."""
    return refusal_for(
        frappe.db.get_value("Work Order", name, "custom_scheduled_application_time")
        or frappe.db.get_value("Work Order", name, "planned_start_date")
    )


@frappe.whitelist()
def planning_window() -> dict:
    """For the planner's date picker."""
    if frappe.session.user == "Guest":
        frappe.throw("Login required.", frappe.PermissionError)
    n = hold_days()
    return {"days": n, "today": str(today()), "max_date": str(add_days(today(), n))}
