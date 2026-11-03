"""Store label printing — feeds the RN Labels tab.

The store user picks a farm + date; the app prints that day's submitted
chemical-transfer labels directly to a Bluetooth Zebra ZQ520 as native ZPL.
This module returns label *data* (with a text ``qr_payload`` the printer
renders natively) rather than the PDF the web Labels page builds. No image is
ever sent, which is why nothing here requires one to exist — see
``_collect_labels(require_image=False)``.
"""

from __future__ import annotations

import json

import frappe

from upande_scp.serverscripts.qr import chemical_labels
from upande_scp.serverscripts.store import store_keeper_api
from upande_scp.serverscripts.spray_plan_ops.spray_plan_labels import (
    _collect_labels,
    _stamp_labels_printed,
)

# Fields the app needs on each print job. image_src is intentionally excluded —
# the printer renders the QR from qr_payload, no image is ever sent.
_JOB_FIELDS = (
    "se_name",
    "chem_name",
    "item_code",
    "qty_str",
    "source",
    "target",
    "scheduled",
    "spray_type",
    "greenhouse",
    "qr_payload",
    "draft",
)


def _to_print_job(label: dict) -> dict:
    """Reshape a ``_collect_labels`` dict into an app print job.

    Pure: drops ``image_src`` and any other extra keys, defaulting any
    missing field to an empty string. ``qr_payload`` is preserved verbatim.
    """
    job = {k: label.get(k, "") for k in _JOB_FIELDS}
    job["draft"] = bool(label.get("draft"))
    return job


def _approved_drafts(
    farm: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> list[dict]:
    """Draft transfers on Approved plans, dated by the plan's spray day.

    The draft is created when the GM approves, so this is the store's work for the
    coming morning. It is dated by when the spray is planned, not by the draft's
    posting date (the approval day), because that is the day the store prints for.
    """
    store_keeper_api._check_perm()
    where = [
        "se.docstatus = 0",
        "se.purpose = %(purpose)s",
        "wo.custom_type = %(afp)s",
        "wo.workflow_state = %(state)s",
    ]
    params = {
        "purpose": chemical_labels.TRANSFER_PURPOSE,
        "afp": chemical_labels.AFP_TYPE,
        "state": chemical_labels.EARLY_STATE,
    }
    if from_date:
        where.append("DATE(wo.custom_scheduled_application_time) >= %(from_date)s")
        params["from_date"] = from_date
    if to_date:
        where.append("DATE(wo.custom_scheduled_application_time) <= %(to_date)s")
        params["to_date"] = to_date
    rows = frappe.db.sql(
        f"""
        SELECT se.name,
               DATE(wo.custom_scheduled_application_time) AS spray_date,
               COALESCE(tw.custom_farm, fw.custom_farm, '') AS farm
        FROM   `tabStock Entry` se
        JOIN   `tabWork Order`  wo ON wo.name = se.work_order
        LEFT   JOIN `tabWarehouse` tw ON tw.name = se.to_warehouse
        LEFT   JOIN `tabWarehouse` fw ON fw.name = se.from_warehouse
        WHERE  {" AND ".join(where)}
        ORDER  BY wo.custom_scheduled_application_time, se.creation
        """,
        params,
        as_dict=True,
    )
    if farm:
        rows = [r for r in rows if (r.get("farm") or "") == farm]
    return rows


def _early_labels(se_names: list[str]) -> tuple[list[dict], list[dict]]:
    """Issue (idempotently) and collect the early labels for approved drafts."""
    for name in se_names:
        try:
            chemical_labels.issue_for_stock_entry(
                frappe.get_doc("Stock Entry", name), early=True
            )
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"Early label issue failed: {name}")
    frappe.db.commit()
    labels, skipped = _collect_labels(se_names, require_image=False)
    for lbl in labels:
        lbl["draft"] = True
    return labels, skipped


@frappe.whitelist()
def get_print_jobs(farm: str | None = None, date: str | None = None) -> dict:
    """Print jobs for a farm + day: one record per printable label.

    Reuses ``store_keeper_api.list_submitted_transfers`` to find that day's
    submitted Material-Transfer-for-Manufacture Stock Entries (same perms,
    purpose, work-order and farm filters), then expands each into per-item
    labels via ``_collect_labels`` and reshapes them with ``_to_print_job``.

    Also includes the day's *approved drafts* (spray planned for ``date``), so the
    store can print the night before the morning issue. Those jobs carry
    ``draft: true``; their codes refuse to scan until the transfer is submitted.

    Returns ``{"jobs": [...], "skipped": [...], "se_count": int, "draft_count": int}``.
    """
    if not farm or not date:
        frappe.throw("farm and date are required")
    listing = store_keeper_api.list_submitted_transfers(
        farm=farm, from_date=date, to_date=date
    )
    se_names = [r["name"] for r in listing.get("rows", [])]
    draft_names = [
        r["name"] for r in _approved_drafts(farm=farm, from_date=date, to_date=date)
        if r["name"] not in se_names
    ]
    if not se_names and not draft_names:
        return {"jobs": [], "skipped": [], "se_count": 0, "draft_count": 0}

    # `require_image=False`: the printer draws the QR from `qr_payload` and is
    # never sent an image, so a missing PNG is no reason to withhold a label it
    # can print perfectly well.
    labels, skipped = (
        _collect_labels(se_names, require_image=False) if se_names else ([], [])
    )
    if draft_names:
        early, early_skipped = _early_labels(draft_names)
        labels += early
        skipped += early_skipped
    jobs = [_to_print_job(lbl) for lbl in labels]
    return {
        "jobs": jobs,
        "skipped": skipped,
        "se_count": len(se_names) + len(draft_names),
        "draft_count": len(draft_names),
    }


@frappe.whitelist()
def mark_labels_printed(se_names) -> dict:
    """Stamp the printed marker on each SE whose labels actually printed.

    ``se_names`` is a JSON list or a list of Stock Entry names. Thin wrapper
    over ``_stamp_labels_printed`` (sets custom_labels_printed, bumps
    custom_labels_print_count, stamps _on/_by). Called by the app after a
    confirmed print, with ONLY the SEs that fully printed.
    """
    store_keeper_api._check_perm()
    if isinstance(se_names, str):
        se_names = json.loads(se_names)
    if not isinstance(se_names, list):
        frappe.throw("se_names must be a list")
    se_names = [s for s in se_names if s]
    if not se_names:
        return {"stamped": 0}
    _stamp_labels_printed(set(se_names))
    frappe.db.commit()
    return {"stamped": len(set(se_names))}


@frappe.whitelist()
def get_label_config() -> dict:
    """Canonical label tier table (shared/label_tiers.json) for the app's
    live preview + ZPL, kept in lockstep with the web preview and PDF."""
    store_keeper_api._check_perm()
    from upande_scp.serverscripts.spray_plan_ops.spray_plan_labels import _load_tiers
    return _load_tiers()


def _distinct_dates(rows) -> list:
    """Distinct posting_date strings (YYYY-MM-DD), newest first."""
    seen = []
    for r in rows:
        d = r.get("posting_date")
        if not d:
            continue
        s = str(d)
        if s not in seen:
            seen.append(s)
    return sorted(seen, reverse=True)


@frappe.whitelist()
def get_label_farms() -> dict:
    """Farm list for the store Labels farm dropdown."""
    listing = store_keeper_api.list_submitted_transfers()
    return {"farms": listing.get("farms", [])}


@frappe.whitelist()
def get_label_dates(farm: str | None = None, days: int = 60) -> dict:
    """Recent posting dates (within ``days``) that have printable labels for
    ``farm``. Used to highlight dates in the store calendar.

    Every submitted transfer is printable here, because the printer builds the
    QR from the label payload rather than from an attached image. This used to
    filter on ``has_qr``, which is derived from a PNG existing on disk — so a
    day's labels vanished from the calendar over a missing file the printer had
    no use for.
    """
    if not farm:
        frappe.throw("farm is required")
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 60
    cutoff = frappe.utils.add_days(frappe.utils.nowdate(), -abs(days))
    listing = store_keeper_api.list_submitted_transfers(farm=farm, from_date=cutoff)
    dates = set(_distinct_dates(listing.get("rows", [])))
    # Approved plans still waiting for the morning issue, by spray day — including
    # tomorrow's, which is the whole point of printing early.
    dates |= {str(r["spray_date"]) for r in _approved_drafts(farm=farm, from_date=cutoff)
              if r.get("spray_date")}
    return {"dates": sorted(dates, reverse=True)}
