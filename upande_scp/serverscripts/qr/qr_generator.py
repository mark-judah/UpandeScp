"""
QR Code generator for Spray Plan Approval.

Public API:
  generate_qr_base64(payload_text)          → base64 PNG str | None
  attach_qr_to_document(doctype, docname, filename, png_base64) → File.name | None
  build_chemical_qr_payload(...)            → newline-separated string
"""

import base64
import re

import frappe


def generate_qr_base64(payload_text, box_size=4, border=2):
    """
    Return a base64-encoded PNG QR code image, or None on failure.

    Defaults are tuned for a 30x40 mm label printer: a box_size of 4 with a
    2-module quiet zone yields a QR that stays readable when scaled to roughly
    18-22 mm square — small enough to leave room for label text.
    """
    try:
        import qrcode
        from io import BytesIO

        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            box_size=box_size,
            border=border,
        )
        qr.add_data(str(payload_text))
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")

        buf = BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    except ImportError:
        frappe.log_error(
            "The 'qrcode' library is not installed.\n"
            "Fix: bench pip install qrcode[pil]",
            "QR Generator – Missing Library",
        )
        return None

    except Exception:
        frappe.log_error(frappe.get_traceback(), "QR Generator – Render Error")
        return None


def attach_qr_to_document(doctype, docname, filename, png_base64):
    """
    Attach a base64 PNG as a private File to a Frappe document.
    Returns the File docname on success, None on failure.
    """
    try:
        png_bytes = base64.b64decode(png_base64)
        file_doc = frappe.get_doc(
            {
                "doctype": "File",
                "file_name": filename,
                "attached_to_doctype": doctype,
                "attached_to_name": docname,
                "is_private": 0,
                "content": png_bytes,
            }
        )
        file_doc.insert(ignore_permissions=True)
        frappe.db.commit()
        return file_doc.name

    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"QR Attach – {doctype}/{docname}: {filename}",
        )
        return None


def build_chemical_qr_payload(chemical_name, qty, uom):
    """
    Build the text encoded into the QR image.

    Encodes chemical name + quantity only — that's what the operator
    needs to verify at the mixing station. The greenhouse, SE name and
    audit trail live on the printed label (rendered next to the QR) and
    on the document, not inside the QR. Keeping the payload to two
    lines holds the QR at a low version (v2, 25x25 modules) with
    chunky cells so it scans reliably on low-DPI thermal printers.
    """
    return f"{chemical_name}\n{_fmt_qty(qty)} {uom}"


def safe_filename(item_code):
    """Return a filesystem-safe version of an item code."""
    return re.sub(r"[^a-zA-Z0-9]", "_", str(item_code))


# ── Internal ──────────────────────────────────────────────────────────────────


def _fmt_qty(val):
    if val is None:
        return "—"
    try:
        n = float(val)
        return str(int(n)) if n % 1 == 0 else f"{n:.3f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return str(val)
