"""Issuing chemical QR labels for a submitted spray transfer.

Labels are issued when the storesman **submits** the Material Transfer, not when
the approver creates it. The submitted transfer is what physically moved, so the
quantity on the sticker is a settled fact. Generating at approval put a *proposed*
quantity on the label — the draft stays editable until submit — and it minted
labels for drafts that were never submitted at all.

Nothing downstream regresses: the Labels page already lists only submitted
entries and dims rows without a QR file (``store_keeper_api.list_submitted_transfers``
derives ``has_qr`` from the SE's image attachments).

kaitet reaches the same conclusion with a richer traceable-code scheme built on its
``Spray Product`` doctype and a dedicated ``Chemical QR Label`` record. Mona keeps
its existing QR payload for now; this module is named to match kaitet's so that
port stays a drop-in.
"""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.qr.qr_generator import (
    attach_qr_to_document,
    build_chemical_qr_payload,
    generate_qr_base64,
    safe_filename,
)

TRANSFER_PURPOSE = "Material Transfer for Manufacture"

#: Only a spray plan's transfer earns a label. ``TRANSFER_PURPOSE`` is ERPNext's
#: ordinary transfer-to-WIP purpose, shared by every manufacturing flow on the
#: site, so purpose alone is not a filter.
AFP_TYPE = "Application Floor Plan"


def issue_for_stock_entry(doc) -> list[dict]:
    """Attach one QR label per transferred line of a submitted Stock Entry.

    Returns the label descriptors (also used by the approval response shape).
    Never raises: a label failure must not roll back an issue that physically
    happened. Each failure is logged against its own item.
    """
    wo_name = getattr(doc, "work_order", None)
    if not wo_name:
        return []

    wo_doc = frappe.get_doc("Work Order", wo_name)
    greenhouse = getattr(wo_doc, "custom_greenhouse", "") or ""
    wip_warehouse = getattr(wo_doc, "wip_warehouse", "") or ""
    farm = _farm_for(greenhouse)

    labels: list[dict] = []
    for item in doc.items or []:
        try:
            payload = build_chemical_qr_payload(
                item.item_name or item.item_code,
                item.qty,
                item.stock_uom,
            )
            png_b64 = generate_qr_base64(payload)
            if not png_b64:
                continue
            fname = f"QR_{doc.name}_{safe_filename(item.item_code)}.png"
            attach_qr_to_document("Stock Entry", doc.name, fname, png_b64)
            labels.append(
                {
                    "chemical":   item.item_name or item.item_code,
                    "item_code":  item.item_code,
                    "qty":        _fmt_qty(item.qty),
                    "uom":        item.stock_uom,
                    "src_wh":     item.s_warehouse or "",
                    "tgt_wh":     item.t_warehouse or wip_warehouse,
                    "farm":       farm,
                    "greenhouse": greenhouse,
                    "wo":         wo_name,
                    "se":         doc.name,
                    "png_base64": png_b64,
                }
            )
        except Exception:
            frappe.log_error(
                frappe.get_traceback(), f"QR issue – {doc.name} / {item.item_code}"
            )
    return labels


def _farm_for(greenhouse: str) -> str:
    if not greenhouse:
        return ""
    return frappe.db.get_value("Warehouse", greenhouse, "custom_farm") or ""


def _fmt_qty(val):
    if val is None:
        return "—"
    try:
        n = float(val)
        return str(int(n)) if n % 1 == 0 else f"{n:.3f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return str(val)
