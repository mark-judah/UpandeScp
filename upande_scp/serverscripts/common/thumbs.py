"""Thumbnail service for scouting photos (scouts upload full-size phone images).

    GET /api/method/upande_scp.serverscripts.common.thumbs.thumb?src=/files/x.jpg&w=480

Resizes to WebP (quality 70, EXIF orientation honoured, never upscaled) at one
of ``WIDTHS`` and caches the result on disk, keyed by ``sha1(src + mtime)`` so a
replaced file gets a fresh thumb:

* public file  -> ``<site>/public/files/scp_thumbs/<key>_<w>.webp``; the request
  answers a 302 to ``/files/scp_thumbs/<key>_<w>.webp`` and nginx serves every
  repeat as a static file;
* private file -> ``<site>/private/scp_thumbs/<key>_<w>.webp`` (never under
  public/); always served through this method, after the File permission
  check, with ``Cache-Control: private``.

``src`` must be a ``/files/`` or ``/private/files/`` path of an existing File
record the session user may read; anything else (traversal, other prefixes,
unlisted widths, non-images) is refused.
"""

import hashlib
import io
import os
import posixpath
from urllib.parse import unquote

import frappe
from werkzeug.wrappers import Response

WIDTHS = (240, 480, 960, 1600)
QUALITY = 70
PUBLIC_DIR = "scp_thumbs"
MAX_PIXELS = 100_000_000


def _fail(msg: str, exc=None):
    frappe.throw(msg, exc or frappe.ValidationError)


def clean_src(src: str) -> str:
    """The normalized ``/files/...`` or ``/private/files/...`` path, or throw."""
    src = unquote((src or "").strip())
    if (
        not src
        or "\x00" in src
        or "\\" in src
        or "?" in src
        or "#" in src
        or any(p == ".." for p in src.split("/"))
        or posixpath.normpath(src) != src.rstrip("/")
        or not (src.startswith("/files/") or src.startswith("/private/files/"))
    ):
        _fail("Invalid image path.")
    return src


def clean_width(w) -> int:
    try:
        w = int(w)
    except (TypeError, ValueError):
        _fail("Invalid width.")
    if w not in WIDTHS:
        _fail(f"Width must be one of {', '.join(map(str, WIDTHS))}.")
    return w


def _file_row(src: str):
    name = frappe.db.get_value("File", {"file_url": src, "is_folder": 0}, "name")
    if not name:
        _fail("File not found.", frappe.DoesNotExistError)
    doc = frappe.get_doc("File", name)
    if not frappe.has_permission("File", "read", doc=doc):
        _fail("Not permitted.", frappe.PermissionError)
    return doc


def _source_path(src: str, private: bool) -> str:
    rel = src[len("/private/"):] if private else src.lstrip("/")
    base = os.path.realpath(frappe.get_site_path("private" if private else "public"))
    path = os.path.realpath(os.path.join(base, rel))
    if os.path.commonpath([base, path]) != base:
        _fail("Invalid image path.")
    if not os.path.isfile(path):
        _fail("File not found.", frappe.DoesNotExistError)
    return path


def thumb_path(src: str, w: int, mtime: float) -> tuple:
    """``(absolute cache path, public url or None)`` for the thumb."""
    key = hashlib.sha1(f"{src}|{int(mtime)}".encode()).hexdigest()
    fname = f"{key}_{w}.webp"
    if src.startswith("/private/"):
        return frappe.get_site_path("private", PUBLIC_DIR, fname), None
    return (
        frappe.get_site_path("public", "files", PUBLIC_DIR, fname),
        f"/files/{PUBLIC_DIR}/{fname}",
    )


def render(path: str, w: int) -> bytes:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            if im.width > w:
                im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "transparency" in im.info or im.mode in ("LA", "PA") else "RGB")
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=QUALITY, method=4)
            return buf.getvalue()
    except (OSError, Image.DecompressionBombError) as e:
        _fail(f"Not a readable image ({e.__class__.__name__}).")


def ensure_thumb(src: str, w: int, private: bool) -> tuple:
    """Build the thumb if missing; ``(cache path, public url or None)``."""
    mtime = os.path.getmtime(_source_path(src, private))
    out, url = thumb_path(src, w, mtime)
    if not os.path.isfile(out):
        data = render(_source_path(src, private), w)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp = f"{out}.{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, out)
    return out, url


@frappe.whitelist()
def thumb(src, w=480):
    src = clean_src(src)
    w = clean_width(w)
    _file_row(src)
    private = src.startswith("/private/")
    out, url = ensure_thumb(src, w, private)
    if url:
        resp = Response(status=302)
        resp.headers["Location"] = url
        resp.headers["Cache-Control"] = "public,max-age=86400"
        return resp
    with open(out, "rb") as f:
        resp = Response(f.read(), mimetype="image/webp")
    resp.headers["Cache-Control"] = "private,max-age=86400"
    return resp


def backfill(limit: int = 0, widths=(480, 960)):
    """Pre-build thumbs for every Scouting Entry Photo (and trap photo).

    bench --site kaitet.local execute upande_scp.serverscripts.common.thumbs.backfill
    """
    srcs = frappe.db.sql_list(
        "SELECT DISTINCT image FROM `tabScouting Entry Photo` "
        "WHERE IFNULL(image,'') != '' ORDER BY modified DESC" + (f" LIMIT {int(limit)}" if limit else "")
    )
    done = failed = 0
    for src in srcs:
        for w in widths:
            try:
                ensure_thumb(clean_src(src), clean_width(w), src.startswith("/private/"))
                done += 1
            except Exception:
                failed += 1
    print(f"thumbs built or present: {done}, skipped: {failed}")
    return {"built": done, "skipped": failed}
