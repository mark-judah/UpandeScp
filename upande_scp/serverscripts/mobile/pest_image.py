"""Attach a scouting photo to its Scouting Entry, and alert the GM when it is
of something the scout could not name (piece 5; ported from Mona f5f6392 /
8be897b, kaitet names).

A scout may photograph anything on a round: a finding they recorded (the pest,
disease or other observation is its `subject`), or the entry in general
(`subject` "General"). Every picture carries its own caption, stored on a
**Scouting Entry Photo** row of the entry; the picture itself is a private File
attached to the entry. Whether the scouting form offers a camera at all is the
General Manager's (`scouting.capture_settings`).

The handset uploads the compressed photo out-of-band, keyed by the parent
submission's `client_id`. We resolve the Scouting Entry from that id (via
Scouting Entry Metadata). If the entry has not synced yet we answer
`{"status": "pending"}` and the phone retries later.

TWO KINDS, ONE ENDPOINT. A photo of something unidentified is the trap tab's
alarm: the app demands it, and it emails every SCP General Manager. It is
always accepted, photos switch or not (spec P5: trap photos keep working). Any
other photo is documentation: quiet, and refused when the GM switched photos
off. The refusal is an ordinary `{"status": "refused"}` answer, not a
PermissionError: an expired session also answers 403, and the handset must
not throw away a photo the server would have taken.
"""

import hashlib
import os
import re

import frappe

from upande_scp.serverscripts.scouting import capture_settings

REFUSED_MESSAGE = (
    "Photos are switched off for this farm in Scouting and Crop Protection Settings."
)

# Frappe's File.file_name is Data(140).
MAX_FILE_NAME = 140
_SUBJECT_LIMIT = 40
_DIGEST_LEN = 10
_PHOTO_ID_LIMIT = 64
_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".heic")
UNIDENTIFIED = "Unidentified"
NOT_YOURS_MESSAGE = "Only the scout who made this entry, or a General Manager, may add photos to it."


def _gm_recipients():
    """Email addresses of enabled users holding the SCP General Manager role."""
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


def _may_attach(entry):
    """The entry's scout (createScoutingEntry inserts as the scout, so `owner`
    is the scout), a General Manager, or a System Manager. Not "anyone with
    write": every SCP scout role holds write on Scouting Entry."""
    user = frappe.session.user
    if user == "Administrator" or user == frappe.db.get_value("Scouting Entry", entry, "owner"):
        return True
    return bool({"SCP General Manager", "System Manager"} & set(frappe.get_roles(user)))


def _is_unidentified(name):
    """Does this photo show something the scout could not name?

    Mirrors the client's own rule: `needsPhoto` in traps/index.tsx tests the
    pest name for "unidentified". The app always sends a name, so a missing
    name alone is not the test — but nothing named at all still is."""
    return not name or "unidentified" in name.lower()


def _short_file_name(raw_name, client_id, subject_name, photo_id="", trap=""):
    """A short, portable, deterministic name for the stored photo.

    The client names the upload from the raw client_id, which percent-encodes
    past 140 characters and made the File insert fail; only its extension is
    used. Deterministic because the duplicate check matches on file_name: a
    retry after a lost response must find the first upload. Keyed on
    client_id + subject (Mona), plus the handset's per-photo `photo_id` when it
    sends one, so two photos of one subject on one entry are two photos. A trap
    submission queues one unidentified photo per trap under one client_id and
    no photo_id, so the trap joins the key when there is no photo_id. Only an
    image extension is kept; anything else is stored as .jpg."""
    ext = os.path.splitext(raw_name or "")[1].lower()
    if ext not in _IMAGE_EXTENSIONS:
        ext = ".jpg"
    subject = re.sub(r"[^A-Za-z0-9]+", "-", subject_name or "").strip("-")
    subject = subject[:_SUBJECT_LIMIT] or "photo"
    key = f"{client_id}|{subject_name}"
    if photo_id:
        key += f"|{photo_id}"
    elif trap:
        key += f"|{trap}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
    return f"{subject}-{digest[:_DIGEST_LEN]}{ext}"[:MAX_FILE_NAME]


@frappe.whitelist()
def attach_scouting_photo():
    """Store one photo against its Scouting Entry, with the caption it carries."""
    client_id = frappe.form_dict.get("client_id")
    pest = (frappe.form_dict.get("pest") or "").strip()
    disease = (frappe.form_dict.get("disease") or "").strip()
    trap = frappe.form_dict.get("trap") or ""
    caption = (frappe.form_dict.get("caption") or "").strip()
    photo_id = (frappe.form_dict.get("photo_id") or "").strip()[:_PHOTO_ID_LIMIT]

    # pest / disease stay ahead of `subject` for the handsets that only name them.
    kind = "disease" if disease and not pest else "pest"
    subject_name = pest or disease or (frappe.form_dict.get("subject") or "").strip() or UNIDENTIFIED
    is_unidentified = _is_unidentified(subject_name)

    if not is_unidentified and not capture_settings.allows("photos"):
        # The app is told before it draws the camera, so arriving here means a
        # stale handset or a switch flipped mid-round. Nothing is stored.
        frappe.response["data"] = {
            "status": "refused",
            "reason": "photos-off",
            "message": REFUSED_MESSAGE,
        }
        return

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

    # Only the scout who made the entry (or someone allowed to edit it) may
    # add to it: the endpoint is whitelisted and the client_id is not a secret.
    if not _may_attach(entry):
        frappe.response["data"] = {
            "status": "refused",
            "reason": "not-yours",
            "message": NOT_YOURS_MESSAGE,
        }
        return

    content = file_obj.stream.read()
    fname = _short_file_name(file_obj.filename, client_id, subject_name, photo_id, trap)

    file_url = _already_uploaded(entry, fname, content)
    if not file_url:
        # Frappe's File.write_file() does NOT create the files directory.
        os.makedirs(frappe.get_site_path("private", "files"), exist_ok=True)

        from frappe.utils.file_manager import save_file

        file_url = save_file(fname, content, "Scouting Entry", entry, is_private=1).file_url

    if not _record_on_entry(entry, file_url, caption, subject_name):
        # A retry after a lost success response: the row is already there (a
        # retry may still carry a caption the first attempt never delivered,
        # so its words were reconciled), and the GM has had the email.
        frappe.db.commit()
        frappe.response["data"] = {"status": "ok", "duplicate": True, "entry": entry}
        return
    frappe.db.commit()

    # Best-effort GM email (P8: only for something unnamed) — a mail failure
    # must not fail the upload; the photo is already on the entry.
    try:
        recipients = _gm_recipients() if is_unidentified else []
        if recipients:
            gh = frappe.db.get_value("Scouting Entry", entry, "greenhouse") or ""
            esc = frappe.utils.escape_html
            label = subject_name
            frappe.sendmail(
                recipients=recipients,
                subject=f"Unidentified {kind} photo — {label}",
                message=(
                    f"<p>A scout flagged an unidentified {kind} and attached a photo.</p>"
                    "<ul>"
                    f"<li><b>{kind.capitalize()}:</b> {esc(label)}</li>"
                    f"<li><b>Trap:</b> {esc(trap) or '—'}</li>"
                    f"<li><b>Greenhouse:</b> {esc(gh) or '—'}</li>"
                    f"<li><b>Scouting Entry:</b> {entry}</li>"
                    + (f"<li><b>Caption:</b> {esc(caption)}</li>" if caption else "")
                    + "</ul><p>Photo attached.</p>"
                ),
                attachments=[{"fname": fname, "fcontent": content}],
            )
    except Exception:
        frappe.log_error("attach_scouting_photo: GM email failed", frappe.get_traceback())

    frappe.response["data"] = {
        "status": "ok",
        "file": file_url,
        "entry": entry,
        "subject": subject_name,
        "caption": caption,
        "notified": is_unidentified,
    }


#: The name the handsets in the field call. A phone updates when its owner is
#: next on wifi, not the week the server does, so the old route keeps
#: answering — it IS the new endpoint, not a copy of it.
attach_unidentified_pest_image = attach_scouting_photo


def _already_uploaded(entry, fname, content):
    """The file_url of this picture if it is already attached to the entry.

    Frappe's save_file dedupes identical bytes: the second File copies the
    first one's file_url and, unless the JPEG's EXIF was stripped on the way
    in, its file_name too. So a retry is found by our deterministic file_name
    OR by the content hash on this same entry."""
    from frappe.utils.file_manager import get_content_hash

    attached = {"attached_to_doctype": "Scouting Entry", "attached_to_name": entry}
    return frappe.db.get_value("File", {**attached, "file_name": fname}, "file_url") or frappe.db.get_value(
        "File", {**attached, "content_hash": get_content_hash(content)}, "file_url"
    )


def _record_on_entry(entry, file_url, caption, subject_name):
    """Put the picture on the entry itself, not only in the File table.

    Keyed by (file_url, subject): identical bytes under two subjects share one
    file_url (Frappe's hash dedupe), and each subject keeps its own row and
    caption. A retry updates the words rather than adding a picture. Returns
    True when a row was added, False when it was already there."""
    if not file_url:
        return False

    doc = frappe.get_doc("Scouting Entry", entry)
    for row in doc.get("photos_scouting_entry") or []:
        if row.image == file_url and row.subject == subject_name:
            if caption and row.caption != caption:
                row.db_set("caption", caption, update_modified=False)
            return False

    row = doc.append(
        "photos_scouting_entry",
        {
            "image": file_url,
            "caption": caption,
            "subject": subject_name,
            "captured_on": frappe.utils.now(),
        },
    )
    # The child is written directly rather than through a parent save: the
    # upload is decoupled from the sync on purpose, and re-saving the entry
    # would re-run its validation and hooks for a picture.
    row.insert(ignore_permissions=True)
    return True
