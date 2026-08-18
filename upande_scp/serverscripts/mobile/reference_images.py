"""Reference-image manifest for the mobile app: download each photo once, ever.

The scouting screens want a photo beside every pest, disease, predator and
disorder so a scout can match what they are looking at against the master. The
photos are static — a pest's damage-symptom picture changes maybe once a year —
so re-downloading them on every sync is pure waste on a field phone with a
metered connection.

## How "download once" works

Every image file on this site is **public**, so the phone fetches the bytes
straight from `/files/…`; this endpoint never streams them. What it returns is a
*manifest*: for each master record, the URL plus a `content_hash` of the bytes
behind it. The phone keeps `key → content_hash` for what it has already stored
and downloads only the entries whose hash it does not hold.

Hashing the **bytes**, not the URL, is what makes the contract honest:

* re-uploading a new photo under the same file name still changes the hash, so
  the phone notices — a URL-only check would serve a stale picture forever;
* renaming the record without touching the photo does *not* change the hash, so
  nothing is re-downloaded.

A `version` digest over the whole manifest lets the phone skip the payload
entirely on the common no-change case, matching `getFarmDataBundle`.

## Why the manifest does not point at the originals

The masters' photos are full-resolution research downloads: 47 files totalling
**44 MB** on kaitet, averaging 944 KB each, up to 2048 px wide. Downloading that
once is still a bad first sync on a metered field connection, and a phone showing
a 120 px thumbnail has no use for 2048 px.

So the manifest points at a **derivative**: the same picture fitted inside
`_MAX_EDGE` px as a progressive JPEG. Measured on kaitet, a 1431 KB / 2048 px
original comes out at 61 KB — the whole set drops from 44 MB to roughly 2 MB.
The original stays reachable as `full_url` for a tap-to-zoom view.

A derivative is only used when it is genuinely smaller. Three of kaitet's photos
are already small and already well compressed, and re-encoding them *grew* the
file; those entries serve the original instead. So `size <= full_size` always
holds, and the phone never downloads more than it has to.

Derivatives are named by the **source's content hash**, so they are immutable:
the phone (and any CDN) can cache one forever, and re-uploading a master's photo
produces a different name rather than a stale hit. They are written under
`public/files/scp_ref/` and generated on first request, so nothing has to be
backfilled and a new photo needs no extra step.

## Cost

Hashing and resizing 47 files takes long enough that the manifest is Redis-cached
(`TTL_MEDIUM`), each file's hash is memoised against its size and mtime, and a
derivative that already exists on disk is never regenerated. A warm call does no
disk reads at all; a cold one after a photo change re-renders only that photo.
"""

from __future__ import annotations

import hashlib
import json
import os

import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_SM_REFERENCE_IMAGES,
    TTL_MEDIUM,
    get_or_set,
)


# One entry per master that carries a scout-facing photo. The image field
# differs per doctype (`damage_symptoms` on the pest/disease masters, `photo` on
# the others) which is exactly why the phone wants a single flat manifest rather
# than four doctype-shaped payloads.
_SOURCES = (
    # (category, doctype, label field, image field)
    ("pest", "Pest", "common_name", "damage_symptoms"),
    ("disease", "Plant Disease", "common_name", "damage_symptoms"),
    ("predator", "Predator", "common_name", "photo"),
    ("disorder", "Physiological Disorder", "disorder_name", "photo"),
)


def _site_path(file_url: str) -> str | None:
    """Absolute path on disk for a `/files/...` or `/private/files/...` URL."""
    if not file_url or not file_url.startswith("/"):
        return None
    # `get_site_path` joins against the site directory; public files live under
    # `public/`, private ones are already rooted at `private/`.
    rel = file_url.lstrip("/")
    if rel.startswith("files/"):
        rel = f"public/{rel}"
    path = frappe.get_site_path(*rel.split("/"))
    return path if os.path.isfile(path) else None


def _hash_file(path: str) -> tuple[str, int] | None:
    """`(sha256, size)` for a file, memoised on (size, mtime).

    The memo is what makes a warm rebuild cheap: nothing is re-read unless the
    file itself changed on disk.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None

    memo_key = f"scp:ref_img_hash:{path}:{st.st_size}:{int(st.st_mtime)}"
    cached = frappe.cache().get_value(memo_key)
    if cached:
        return str(cached), st.st_size

    digest = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(262144), b""):
                digest.update(chunk)
    except OSError:
        return None

    hexed = digest.hexdigest()
    # Long TTL: the key already contains the mtime, so a stale entry is
    # impossible — a changed file simply lands on a different key.
    frappe.cache().set_value(memo_key, hexed, expires_in_sec=7 * 24 * 3600)
    return hexed, st.st_size


# Longest edge of the derivative the phone downloads. 800 px is comfortably more
# than any scouting screen renders, while measuring ~23x smaller than the
# originals — see the module docstring.
_MAX_EDGE = 800
_JPEG_QUALITY = 80

# Public, so the phone fetches derivatives with no auth header, same as the
# originals.
_DERIVATIVE_DIR = ("public", "files", "scp_ref")


def _derivative(path: str, content_hash: str) -> tuple[str, int] | None:
    """`(url, size)` of the scout-sized copy of `path`, rendering it if needed.

    Named by the source's content hash, so the file is immutable and a changed
    source lands on a different name instead of serving a stale picture.

    Returns None when the image cannot be read or Pillow is unavailable; the
    caller then falls back to the original, which is correct but heavy.
    """
    name = f"{content_hash[:16]}_{_MAX_EDGE}.jpg"
    out_dir = frappe.get_site_path(*_DERIVATIVE_DIR)
    out_path = os.path.join(out_dir, name)
    url = f"/files/scp_ref/{name}"

    if os.path.isfile(out_path):
        return url, os.path.getsize(out_path)

    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        os.makedirs(out_dir, exist_ok=True)
        with Image.open(path) as im:
            im.load()
            # `thumbnail` preserves aspect ratio and never upscales, so a photo
            # already smaller than the box is only re-encoded, not stretched.
            im.thumbnail((_MAX_EDGE, _MAX_EDGE), Image.LANCZOS)
            # Write to a temp name and rename, so a concurrent request can never
            # read a half-written JPEG.
            tmp = f"{out_path}.{frappe.generate_hash(length=8)}.tmp"
            im.convert("RGB").save(
                tmp,
                "JPEG",
                quality=_JPEG_QUALITY,
                optimize=True,
                progressive=True,
            )
            # A photo that is already small and already well compressed can come
            # out *larger* after re-encoding — three of kaitet's 47 did. There is
            # nothing to gain from shipping those, so throw the derivative away
            # and let the caller serve the original. This keeps the guarantee the
            # phone relies on: what the manifest offers is never bigger than the
            # original.
            if os.path.getsize(tmp) >= os.path.getsize(path):
                os.unlink(tmp)
                return None
            os.replace(tmp, out_path)
    except Exception:
        frappe.log_error(
            f"Could not build reference-image derivative for {path}",
            "SCP Reference Images",
        )
        return None

    return url, os.path.getsize(out_path)


def _build_manifest() -> dict:
    images = []
    missing = []

    for category, doctype, label_field, image_field in _SOURCES:
        if not frappe.db.has_column(doctype, image_field):
            continue
        rows = frappe.get_all(
            doctype,
            filters={image_field: ["is", "set"]},
            fields=["name", label_field, image_field],
            order_by="name",
            limit_page_length=0,
        )
        for row in rows:
            url = (row.get(image_field) or "").strip()
            if not url:
                continue
            path = _site_path(url)
            if not path:
                # Field points at a file that is no longer on disk. Report it
                # rather than shipping a URL the phone will 404 on.
                missing.append({"category": category, "name": row["name"], "url": url})
                continue
            hashed = _hash_file(path)
            if not hashed:
                missing.append({"category": category, "name": row["name"], "url": url})
                continue
            content_hash, full_size = hashed
            derived = _derivative(path, content_hash)
            images.append(
                {
                    # Stable cache key on the phone. Includes the category so two
                    # masters of different kinds can share a name without clashing.
                    "key": f"{category}:{row['name']}",
                    "category": category,
                    "doctype": doctype,
                    "name": row["name"],
                    "label": row.get(label_field) or row["name"],
                    # What the phone downloads: the scout-sized copy, or the
                    # original if the derivative could not be built.
                    "url": derived[0] if derived else url,
                    "size": derived[1] if derived else full_size,
                    # The full-resolution original, for a tap-to-zoom view.
                    "full_url": url,
                    "full_size": full_size,
                    # Hash of the ORIGINAL's bytes. The derivative is a pure
                    # function of it, so this is the right thing for the phone to
                    # cache against either way.
                    "content_hash": content_hash,
                }
            )

    # Digest over what the phone actually consumes, so a label-only edit still
    # bumps the version (the app shows the label under the photo).
    payload = json.dumps(
        [[i["key"], i["url"], i["content_hash"], i["label"]] for i in images],
        sort_keys=True,
    )
    return {
        "version": hashlib.sha256(payload.encode()).hexdigest()[:16],
        "count": len(images),
        "total_bytes": sum(i["size"] for i in images),
        "images": images,
        "missing": missing,
    }


@frappe.whitelist()
def getReferenceImages(version=None):
    """Manifest of every pest / disease / predator / disorder photo.

    Args:
        version: digest the phone holds from its last successful download. When
            it matches we answer `{"unchanged": true}` and nothing else.

    Response shape::

        {"data": {
            "version": "9f2c…",          # pass back next time
            "unchanged": false,
            "count": 48,
            "total_bytes": 4210233,
            "images": [{
                "key": "pest:Antestia Bug",   # what the phone caches against
                "category": "pest",
                "doctype": "Pest",
                "name": "Antestia Bug",
                "label": "Antestia Bug",
                "url": "/files/scp_ref/7139e47ea3ee1a0c_800.jpg",  # download this
                "size": 62410,
                "full_url": "/files/antestia_bug6ed297.jpeg",      # tap to zoom
                "full_size": 1465858,
                "content_hash": "3b1f…",     # sha256 of the original's bytes
            }, ...],
            "missing": [...],            # field set, file gone — for the office
        }}

    The phone downloads `url` for any entry whose `content_hash` it does not
    already hold, and nothing else. Files are public, so no auth header is
    needed on those GETs, and derivative URLs are immutable so they may be
    cached indefinitely.
    """
    manifest = get_or_set(K_SM_REFERENCE_IMAGES, _build_manifest, ttl=TTL_MEDIUM)

    if version and version == manifest.get("version"):
        frappe.response["message"] = {
            "data": {"version": manifest["version"], "unchanged": True}
        }
        return frappe.response["message"]

    frappe.response["message"] = {"data": {**manifest, "unchanged": False}}
    return frappe.response["message"]
