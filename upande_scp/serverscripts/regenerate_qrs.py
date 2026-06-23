"""Backfill QR PNGs that have a ``tabFile`` row but no bytes on disk.

The Spray-Plan-Approval flow generates one ``QR_<SE>_<item_code>.png``
per chemical line and attaches it to the Stock Entry. Some of those
PNGs have since gone missing from disk (cleanup gone wrong, restore
without the public/files tree, etc.) — the File doc is still there,
which is why the Labels page used to think the QR existed but the PDF
renderer skipped them as ``image files missing on disk``.

This module rebuilds the PNG content from the SE + Work Order data and
writes it to the exact disk path the File doc already points at, so
existing references keep working without touching the DB.

Invoke from a bench shell:

    bench --site <site> execute \\
        upande_scp.serverscripts.regenerate_qrs.run

Pass ``--kwargs '{"dry_run": true}'`` to see what would be rebuilt
without writing anything, or ``--kwargs '{"se_names": ["SE-..."]}'``
to scope to specific Stock Entries.
"""

import json
import os
import re
from typing import Iterable

import frappe

from upande_scp.serverscripts.qr_generator import (
    build_chemical_qr_payload,
    generate_qr_base64,
)


# Same regex the renderer uses to peel ``item_code`` off the filename.
_FILENAME_ITEM_RE = re.compile(r"_([^_]+)\.[^.]+$")


def _disk_path_for(file_url: str) -> str:
    if not file_url:
        return ""
    if file_url.startswith("/private/files/"):
        root = frappe.get_site_path("private", "files")
        return os.path.join(root, file_url[len("/private/files/"):])
    if file_url.startswith("/files/"):
        root = frappe.get_site_path("public", "files")
        return os.path.join(root, file_url[len("/files/"):])
    return ""


def _missing_qr_files(
    se_names: list[str] | None,
    latest_n: int | None = None,
) -> list[dict]:
    """Return File rows whose on-disk PNG is gone.

    ``latest_n`` scopes to the most recent N Stock Entries (by SE
    creation) that have any missing QR PNG attached. Useful for
    bounded backfills — the universe of orphaned File docs across
    history can run into thousands.
    """
    filters = {
        "attached_to_doctype": "Stock Entry",
        "file_name": ("like", "QR_%.png"),
    }
    if se_names:
        filters["attached_to_name"] = ("in", se_names)
    rows = frappe.get_all(
        "File",
        filters=filters,
        fields=["name", "attached_to_name", "file_url", "file_name"],
    )
    missing = []
    for r in rows:
        path = _disk_path_for(r["file_url"])
        if path and not os.path.isfile(path):
            r["_disk_path"] = path
            missing.append(r)

    if latest_n and not se_names:
        # Order by SE creation (newest first), then keep all File rows
        # belonging to the top ``latest_n`` SEs.
        affected_ses = {m["attached_to_name"] for m in missing}
        if not affected_ses:
            return missing
        se_creation = {
            r["name"]: r["creation"]
            for r in frappe.get_all(
                "Stock Entry",
                filters={"name": ("in", list(affected_ses))},
                fields=["name", "creation"],
            )
        }
        latest_ses = set(
            sorted(affected_ses, key=lambda n: se_creation.get(n) or "", reverse=True)[
                :latest_n
            ]
        )
        missing = [m for m in missing if m["attached_to_name"] in latest_ses]
    return missing


def _regenerate_one(file_row: dict) -> str:
    """Rebuild the PNG bytes for one missing File row.

    The payload is just the chemical name + quantity (built by
    ``build_chemical_qr_payload``) so the QR stays at a low version
    with chunky modules — readable on low-DPI thermal printers and at
    the xs/s label tiers. The renderer picks any image attached to the
    SE row, so the file_url stays the same and existing references
    keep working.

    Returns the disk path written, or raises with a human-readable
    reason if the SE / item lookup or QR rendering fails.
    """
    se_name = file_row["attached_to_name"]
    fname = file_row["file_name"]
    m = _FILENAME_ITEM_RE.search(fname)
    if not m:
        raise ValueError(f"can't parse item_code from filename: {fname}")
    item_code = m.group(1)

    se = frappe.get_doc("Stock Entry", se_name)
    item = next((it for it in (se.items or []) if it.item_code == item_code), None)
    if item is None:
        raise ValueError(f"{se_name}: no item row matches {item_code}")

    payload = build_chemical_qr_payload(
        item.item_name or item.item_code,
        item.qty,
        item.stock_uom,
    )
    png_b64 = generate_qr_base64(payload)
    if not png_b64:
        raise RuntimeError(f"{se_name}/{item_code}: qrcode lib produced no output")

    import base64
    png_bytes = base64.b64decode(png_b64)
    path = file_row["_disk_path"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png_bytes)
    return path


def run(
    se_names=None,
    latest_n: int | str | None = None,
    dry_run: bool | int | str = False,
) -> dict:
    """Rebuild every missing-on-disk QR PNG attached to Stock Entries.

    Args:
        se_names: optional list (or JSON-encoded list) of Stock Entry
            names to scope the scan to. ``None`` scans all SEs.
        latest_n: scope to the most recent N Stock Entries (by SE
            creation) that have any missing QR PNG. Ignored when
            ``se_names`` is set.
        dry_run: if truthy, log what would be rebuilt but write nothing.

    Returns a summary dict — printed by ``bench execute`` to stdout.
    """
    if isinstance(se_names, str):
        se_names = json.loads(se_names) if se_names.strip() else None
    if isinstance(dry_run, str):
        dry_run = dry_run.strip().lower() in ("1", "true", "yes", "y")
    if isinstance(latest_n, str):
        latest_n = int(latest_n) if latest_n.strip() else None

    missing = _missing_qr_files(se_names, latest_n=latest_n)
    rebuilt: list[dict] = []
    failed: list[dict] = []

    for row in missing:
        if dry_run:
            rebuilt.append({"se": row["attached_to_name"], "file": row["file_name"], "path": row["_disk_path"]})
            continue
        try:
            path = _regenerate_one(row)
            rebuilt.append({"se": row["attached_to_name"], "file": row["file_name"], "path": path})
        except Exception as e:
            failed.append({"se": row["attached_to_name"], "file": row["file_name"], "error": str(e)})
            frappe.log_error(frappe.get_traceback(), f"QR Regen – {row['file_name']}")

    summary = {
        "scanned_missing": len(missing),
        "rebuilt": len(rebuilt),
        "failed": len(failed),
        "dry_run": bool(dry_run),
        "rebuilt_details": rebuilt,
        "failed_details": failed,
    }
    print(json.dumps(summary, indent=2, default=str))
    return summary
