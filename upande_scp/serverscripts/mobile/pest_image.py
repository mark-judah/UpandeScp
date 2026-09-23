"""Attach a scouting photo to its Scouting Entry, and alert the GM when it is
of something the scout could not name.

A scout may photograph ANYTHING on a round — the camera is no longer reserved
for a pest named "unidentified" — and every picture carries its own caption, so
the words about it live on the same row rather than in a note about the whole
entry. Whether the camera appears at all is the General Manager's to say; see
`serverscripts.scouting.capture_settings`.

The mobile app uploads the (already compressed) photo out-of-band, keyed by the
parent scouting submission's ``client_id``. We resolve the Scouting Entry from
that id (via Scouting Entry Metadata), store the photo as a private File
attached to the entry, and email the General Manager with the photo attached.

If the parent entry hasn't synced yet we return ``{"status": "pending"}`` so the
phone retries later — the photo upload is fully decoupled from the data sync.

The same endpoint carries two different things. A photo of an identified pest or
disease is documentation: it attaches and stays quiet. A photo of something the
scout could not name is the original case, and worth interrupting the GM for.

The test mirrors the client's — the app demands a photo when the pest name reads
"unidentified" — rather than a flag the two ends could disagree about. Without
the distinction a scout documenting ten findings on a round would send ten
alerts, and the alert would stop meaning anything.
"""

import hashlib
import os
import re

import frappe

from upande_scp.serverscripts.scouting import capture_settings


def _gm_recipients():
    """Email addresses of enabled users holding the General Manager role."""
    users = frappe.get_all(
        "Has Role",
        filters={"role": "General Manager", "parenttype": "User"},
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


def _is_unidentified(name):
    """Does this photo show something the scout could not name?

    Mirrors the client's own rule — `needsPhoto` in traps/index.tsx tests the
    pest name for "unidentified", which is why a photo was demanded at all. The
    app always sends a name, so "no name supplied" is NOT the test: using it
    would mean the alert never fires again.
    """
    return not name or "unidentified" in name.lower()


# Frappe's File.file_name is Data(140).
MAX_FILE_NAME = 140
_SUBJECT_LIMIT = 40
_DIGEST_LEN = 10


def _short_file_name(raw_name, client_id, subject_name):
    """A short, portable, *deterministic* name for the stored photo.

    The client names the upload from the raw client_id — email|date|time|
    greenhouse|bed — whose separators percent-encode on the wire ('_7C', '_3A',
    '_20' apiece). That routinely lands past 140 characters and the File insert
    raises CharacterLengthExceededError, losing a photo the phone had already
    uploaded and marked done. So the client's name is not used for length; only
    its extension is.

    Deterministic is the load-bearing word: the duplicate check below matches on
    file_name, so a random or timestamped name would let every retry of a lost
    success response attach another copy. Keyed on client_id + subject to match
    the identity the old name encoded.
    """
    ext = re.sub(r"[^A-Za-z0-9.]+", "", os.path.splitext(raw_name or "")[1])[:8] or ".jpg"
    subject = re.sub(r"[^A-Za-z0-9]+", "-", subject_name or "").strip("-")
    subject = subject[:_SUBJECT_LIMIT] or "photo"
    digest = hashlib.sha1(f"{client_id}|{subject_name}".encode("utf-8")).hexdigest()
    return f"{subject}-{digest[:_DIGEST_LEN]}{ext}"[:MAX_FILE_NAME]


@frappe.whitelist()
def attach_scouting_photo():
    """Store one photo against its Scouting Entry, with the caption it carries.

    The subject is whatever the scout named it — a pest, a disease, or nothing
    at all, because "a picture of this" is a legitimate thing to send. The
    caption is the scout's own words and is the reason this row exists: a File
    alone cannot hold them.
    """
    if not capture_settings.allows("photos"):
        # The app is told this before it draws the camera, so arriving here
        # means a stale handset or a switch flipped mid-round. Refusing plainly
        # beats storing a photo the farm has said it does not want.
        frappe.throw(
            frappe._("Photos are switched off for this farm in Scouting Settings."),
            frappe.PermissionError,
        )

    client_id = frappe.form_dict.get("client_id")
    pest = (frappe.form_dict.get("pest") or "").strip()
    disease = (frappe.form_dict.get("disease") or "").strip()
    trap = frappe.form_dict.get("trap") or ""
    caption = (frappe.form_dict.get("caption") or "").strip()

    # `subject` is what a scout photographing something uncategorised sends.
    # pest / disease stay ahead of it for the handsets that still name them.
    subject_name = pest or disease or (frappe.form_dict.get("subject") or "").strip()
    is_unidentified = _is_unidentified(subject_name)

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
    fname = _short_file_name(file_obj.filename, client_id, subject_name)

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
        # The photo is already here; a retry may still be carrying a caption the
        # first attempt never delivered, so the row is reconciled either way.
        _record_on_entry(entry, frappe.db.get_value("File", existing, "file_url"),
                         caption, subject_name)
        frappe.response["data"] = {"status": "ok", "duplicate": True, "entry": entry}
        return

    # Frappe's File.write_file() opens the target path directly and does NOT
    # create the files directory. On a site that has never stored a private file
    # the directory is missing and the write fails with FileNotFoundError, so
    # ensure it exists first.
    os.makedirs(frappe.get_site_path("private", "files"), exist_ok=True)

    from frappe.utils.file_manager import save_file

    saved = save_file(fname, content, "Scouting Entry", entry, is_private=1)
    _record_on_entry(entry, saved.file_url, caption, subject_name)
    frappe.db.commit()

    # Best-effort GM email — a mail failure must not fail the upload (the photo
    # is already attached to the entry). Only for something unnamed.
    try:
        recipients = _gm_recipients() if is_unidentified else []
        if recipients:
            gh = frappe.db.get_value("Scouting Entry", entry, "greenhouse") or ""
            esc = frappe.utils.escape_html
            subject = "Unidentified pest photo"
            message = (
                "<p>A scout flagged an unidentified pest and attached a photo.</p>"
                "<ul>"
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

    frappe.response["data"] = {
        "status": "ok",
        "file": saved.file_url,
        "entry": entry,
        "subject": subject_name or "Unidentified",
        "caption": caption,
        "notified": is_unidentified,
    }


#: The name the handsets in the field call. A phone updates when its owner is
#: next on wifi, which is not the same week the server does, so the old route
#: keeps answering rather than failing a photo already taken.
attach_unidentified_pest_image = attach_scouting_photo


def _record_on_entry(entry, file_url, caption, subject_name):
    """Put the picture on the entry itself, not only in the File table.

    Before this the photos were File rows and nothing more: attached to the
    entry, invisible on it, and with nowhere for a caption to go. The row is
    keyed by file_url so a retry updates the words rather than adding a second
    picture.
    """
    if not file_url:
        return

    doc = frappe.get_doc("Scouting Entry", entry)
    for row in doc.get("photos_scouting_entry") or []:
        if row.image == file_url:
            if caption and row.caption != caption:
                row.db_set("caption", caption, update_modified=False)
            return

    row = doc.append(
        "photos_scouting_entry",
        {
            "image": file_url,
            "caption": caption,
            "subject": subject_name,
            "captured_on": frappe.utils.now(),
        },
    )
    # The parent is routinely submitted by the time its photo lands — the
    # upload is decoupled from the sync on purpose — so the child is written
    # directly rather than through a save the docstatus would refuse.
    row.insert(ignore_permissions=True)
