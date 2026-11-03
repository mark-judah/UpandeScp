"""Which Email Account SCP reports go out from, and how busy each one is.

The GM picks one account per company on the Settings page (the
``report_sender_accounts`` table on Scouting and Crop Protection Settings) and
a default (``report_email_account``) for companies without a row. Every report,
digest and notification email passes ``sender=report_sender(company)`` to
``frappe.sendmail``; Frappe then matches the outgoing Email Account by that
address. A company's account that is blank, disabled or deleted falls back to
the default, and that to ``None`` — Frappe's own default outgoing account — so
a stale choice never stops a report.

``account_rates`` is what the picker shows beside each account, read from
Email Queue: how many emails it sent in the last hour, how many are waiting on
it, and how many failed in the last day — plus which account to suggest.
"""
from __future__ import annotations

from datetime import timedelta

import frappe

SETTINGS = "Scouting and Crop Protection Settings"
FIELD = "report_email_account"


CHILD = "Report Sender Account"


def chosen_account() -> str | None:
    return frappe.db.get_single_value(SETTINGS, FIELD) or None


def company_accounts() -> dict[str, str]:
    """``{company: Email Account name}`` from the per-company table."""
    if not frappe.db.table_exists(CHILD):
        return {}
    rows = frappe.get_all(
        CHILD,
        filters={"parent": SETTINGS, "parenttype": SETTINGS},
        fields=["company", "email_account"],
        order_by="idx asc",
    )
    return {r.company: r.email_account for r in rows if r.company and r.email_account}


def _usable_address(name: str | None) -> str | None:
    """The account's address when it exists, can send and has one; else None."""
    if not name:
        return None
    row = frappe.db.get_value("Email Account", name, ["email_id", "enable_outgoing"], as_dict=True)
    if not row or not row.enable_outgoing or not row.email_id:
        return None
    return row.email_id


def report_sender(company: str | None = None) -> str | None:
    """The address a report goes out from, or None to let Frappe use its default.

    The company's own account when it has a usable one, else the default
    account, else None. A stale choice (deleted, outgoing turned off) falls
    through, so it never stops a report. No company = the default.
    """
    if company:
        addr = _usable_address(company_accounts().get(company))
        if addr:
            return addr
    return _usable_address(chosen_account())


def company_of_farm(farm: str | None) -> str | None:
    return (frappe.db.get_value("Farm", farm, "company") or None) if farm else None


def company_of_warehouse(warehouse: str | None) -> str | None:
    """Warehouse.custom_farm -> Farm.company."""
    if not warehouse:
        return None
    return company_of_farm(frappe.db.get_value("Warehouse", warehouse, "custom_farm"))


def sole_company(companies) -> str | None:
    """The one company in ``companies``, or None when there are none or several
    (an email spanning companies goes out from the default account)."""
    found = {c for c in companies if c}
    return next(iter(found)) if len(found) == 1 else None


def sender_for_farms(farms) -> str | None:
    """``report_sender`` for an email about ``farms``: their company when they
    share one, else the default."""
    return report_sender(sole_company(company_of_farm(f) for f in set(farms or [])))


def suggest(accounts: list[dict]) -> str | None:
    """The account to recommend: none failing, then the least busy. Pure.

    Busy is what it sent in the last hour plus what is still waiting on it, so
    an account with a backlog is not suggested just because little got out.
    """
    if not accounts:
        return None
    best = min(accounts, key=lambda a: (a["failed"] > 0, a["failed"], a["queued"] + a["last_hour"], not a["is_default"]))
    return best["name"]


def account_rates(now=None) -> dict:
    """Every outgoing Email Account with a snapshot of how it is doing.

    ``last_hour``: sent in the last 60 minutes. ``queued``: waiting to send right
    now, however old. ``failed``: errored in the last 24 hours — a sign the
    account may not deliver.
    """
    now = now or frappe.utils.now_datetime()
    accounts = frappe.get_all(
        "Email Account",
        filters={"enable_outgoing": 1},
        fields=["name", "email_id", "default_outgoing", "smtp_server", "service"],
        order_by="default_outgoing desc, name asc",
    )
    default = next((a.name for a in accounts if a.default_outgoing), None)
    stats = {a.name: {"last_hour": 0, "queued": 0, "failed": 0} for a in accounts}
    rows = frappe.db.sql(
        """
        SELECT email_account,
            SUM(status IN ('Sent', 'Partially Sent') AND creation >= %(hour)s) AS last_hour,
            SUM(status IN ('Not Sent', 'Sending')) AS queued,
            SUM(status = 'Error' AND creation >= %(day)s) AS failed
        FROM `tabEmail Queue`
        WHERE status IN ('Not Sent', 'Sending')
            OR (creation >= %(day)s AND creation <= %(now)s)
        GROUP BY email_account
        """,
        {"now": now, "hour": now - timedelta(hours=1), "day": now - timedelta(days=1)},
        as_dict=True,
    )
    for r in rows:
        # A queue row without an account goes out on the default one.
        s = stats.get(r.email_account or default)
        if s is None:
            continue
        for k in s:
            s[k] += int(r.get(k) or 0)

    out = [
        {
            "name": a.name,
            "email_id": a.email_id,
            "is_default": int(a.default_outgoing or 0),
            "server": a.smtp_server or a.service or "",
            **stats[a.name],
        }
        for a in accounts
    ]
    chosen = chosen_account()
    per_company = company_accounts()
    return {
        "companies": frappe.get_all("Company", pluck="name", order_by="name asc"),
        "company_accounts": [
            {"company": c, "email_account": a, "valid": a in stats} for c, a in per_company.items()
        ],
        "chosen": chosen,
        "chosen_valid": bool(chosen and chosen in stats),
        "default": default,
        "suggested": suggest(out),
        "as_of": str(now),
        "accounts": out,
    }
