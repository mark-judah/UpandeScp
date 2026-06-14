"""Store label printing — feeds the RN Labels tab.

The store user picks a farm + date; the app prints that day's submitted
chemical-transfer labels directly to a Bluetooth Zebra ZQ520 as native ZPL.
This module returns label *data* (with a text ``qr_payload`` the printer
renders natively) rather than the PDF the web Labels page builds.
"""

from __future__ import annotations

import json

import frappe

from upande_scp.serverscripts import store_keeper_api
from upande_scp.serverscripts.spray_plan_labels import (
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
)


def _to_print_job(label: dict) -> dict:
    """Reshape a ``_collect_labels`` dict into an app print job.

    Pure: drops ``image_src`` and any other extra keys, defaulting any
    missing field to an empty string. ``qr_payload`` is preserved verbatim.
    """
    return {k: label.get(k, "") for k in _JOB_FIELDS}


@frappe.whitelist()
def get_print_jobs(farm: str | None = None, date: str | None = None) -> dict:
    """Print jobs for a farm + day: one record per printable label.

    Reuses ``store_keeper_api.list_submitted_transfers`` to find that day's
    submitted Material-Transfer-for-Manufacture Stock Entries (same perms,
    purpose, work-order and farm filters), then expands each into per-item
    labels via ``_collect_labels`` and reshapes them with ``_to_print_job``.

    Returns ``{"jobs": [...], "skipped": [...], "se_count": int}``.
    """
    if not farm or not date:
        frappe.throw("farm and date are required")
    listing = store_keeper_api.list_submitted_transfers(
        farm=farm, from_date=date, to_date=date
    )
    se_names = [r["name"] for r in listing.get("rows", [])]
    if not se_names:
        return {"jobs": [], "skipped": [], "se_count": 0}

    labels, skipped = _collect_labels(se_names)
    jobs = [_to_print_job(lbl) for lbl in labels]
    return {"jobs": jobs, "skipped": skipped, "se_count": len(se_names)}


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
