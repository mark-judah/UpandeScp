"""Attach an "unidentified pest" photo to its Scouting Entry and email the GM.

The mobile app uploads the (already compressed) photo out-of-band, keyed by the
parent scouting submission's ``client_id``. We resolve the Scouting Entry from
that id (via Scouting Entry Metadata), store the photo as a private File
attached to the entry, and email the General Manager with the photo attached.

If the parent entry hasn't synced yet we return ``{"status": "pending"}`` so the
phone retries later — the photo upload is fully decoupled from the data sync.
"""

import os
import re

import frappe


def _gm_recipients():
    """Email addresses of enabled users holding the General Manager role."""
    users = frappe.get_all(
        "Has Role",
        filters={"role": "SCP General Manager", "parenttype": "User"},
        pluck="parent",
    )
    out = []
    for u in set(users):
        if u in ("Administrator", "Guest"):
            continue
        row = frappe.db.get_value("User", u, ["enabled", "email"], as_dict=True)
        if not row or not row.enabled:
            continue
        addr = row.email or u
        if addr and "@" in addr:
            out.append(addr)
    return out


@frappe.whitelist()
def attach_unidentified_pest_image():
    client_id = frappe.form_dict.get("client_id")
    pest = frappe.form_dict.get("pest") or "Unidentified pest"
    trap = frappe.form_dict.get("trap") or ""

    files = getattr(frappe.request, "files", None)
    file_obj = files.get("file") if files else None
    if not client_id or file_obj is None:
        frappe.throw("client_id and file are required")

    entry = frappe.db.get_value(
        "Scouting Entry Metadata", {"client_id": client_id}, "scouting_entry"
    )
    if not entry:
        # Parent Scouting Entry hasn't synced yet — retry later.
        frappe.response["data"] = {"status": "pending"}
        return

    content = file_obj.stream.read()
    # The client names the upload from the raw client_id (email|date|time), which
    # carries ':' and '|' — illegal on some storage backends. Keep only safe
    # characters so the on-disk name is portable.
    raw_name = file_obj.filename or f"{client_id}.jpg"
    fname = re.sub(r"[^A-Za-z0-9._-]+", "_", raw_name).strip("_") or "pest.jpg"

    # Idempotent against client retries after a lost success response.
    existing = frappe.db.get_value(
        "File",
        {
            "attached_to_doctype": "Scouting Entry",
            "attached_to_name": entry,
            "file_name": fname,
        },
        "name",
    )
    if existing:
        frappe.response["data"] = {"status": "ok", "duplicate": True, "entry": entry}
        return

    # Frappe's File.write_file() opens the target path directly and does NOT
    # create the files directory. On a site that has never stored a private file
    # the directory is missing and the write fails with FileNotFoundError, so
    # ensure it exists first.
    os.makedirs(frappe.get_site_path("private", "files"), exist_ok=True)

    from frappe.utils.file_manager import save_file

    saved = save_file(fname, content, "Scouting Entry", entry, is_private=1)
    frappe.db.commit()

    # Best-effort GM email — a mail failure must not fail the upload (the photo
    # is already attached to the entry).
    try:
        recipients = _gm_recipients()
        if recipients:
            gh = frappe.db.get_value("Scouting Entry", entry, "greenhouse") or ""
            esc = frappe.utils.escape_html
            subject = f"Unidentified pest photo — {pest}"
            message = (
                "<p>A scout flagged an unidentified pest and attached a photo.</p>"
                "<ul>"
                f"<li><b>Pest:</b> {esc(pest)}</li>"
                f"<li><b>Trap:</b> {esc(trap) or '—'}</li>"
                f"<li><b>Greenhouse:</b> {esc(gh) or '—'}</li>"
                f"<li><b>Scouting Entry:</b> {entry}</li>"
                "</ul>"
                "<p>Photo attached.</p>"
            )
            frappe.sendmail(
                recipients=recipients,
                subject=subject,
                message=message,
                attachments=[{"fname": fname, "fcontent": content}],
            )
    except Exception:
        frappe.log_error(
            "attach_unidentified_pest_image: GM email failed",
            frappe.get_traceback(),
        )

    frappe.response["data"] = {"status": "ok", "file": saved.file_url, "entry": entry}
