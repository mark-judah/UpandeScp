"""Fetch open-licence reference images for Pest / Plant Disease records.

Pulls a representative photo for each Pest and Plant Disease from GBIF
(https://www.gbif.org, which aggregates iNaturalist and museum collections),
keeping only images whose OWN licence permits commercial use (CC0 or CC-BY),
and attaches the chosen image to the record's `damage_symptoms` field.

Why per-image licence filtering: GBIF's occurrence-level `license` does NOT
match the individual photo's licence (a CC-BY occurrence can hold CC-BY-NC
photos and vice-versa), so we inspect `media[].license` on each image.

Attribution: CC-BY requires crediting the photographer. Even though the image
is attached to the field, every attached photo's credit (creator, licence,
source URL) is written to a manifest CSV so the attribution record is kept.

Matching keys off `scientific_name`. Records with no usable scientific name
(groups like "Caterpillars", or placeholders like "Unidentified Insects")
are skipped and listed in the summary for manual handling.

Run (from the bench directory):

    # Dry run — report what WOULD be attached, write nothing:
    bench --site kaitet.local execute \
        upande_scp.serverscripts.media.fetch_pest_disease_images.run \
        --kwargs "{'dry_run': True}"

    # Real run — attach to records that don't already have an image:
    bench --site kaitet.local execute \
        upande_scp.serverscripts.media.fetch_pest_disease_images.run

    # Also replace images on records that already have one:
    bench --site kaitet.local execute \
        upande_scp.serverscripts.media.fetch_pest_disease_images.run \
        --kwargs "{'overwrite': True}"
"""

import csv
import os

import frappe
import requests

GBIF_SEARCH = "https://api.gbif.org/v1/occurrence/search"
USER_AGENT = "upande_scp-pest-image-fetcher/1.0 (+https://upande.com)"

# Doctypes to populate. Both share the same field shape.
TARGET_DOCTYPES = ("Pest", "Plant Disease")

# How many occurrences to scan per species before giving up on a safe image.
CANDIDATES_PER_QUERY = 60

# Networking guards.
API_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 45
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB sanity cap

# Tokens stripped from a scientific name to leave a queryable taxon.
_RANK_NOISE = ("family", "complex", "spp.", "spp", "sp.", "sp", "group")


def _is_commercial_safe(license_url):
    """True only for CC0 and CC-BY (commercial use allowed, no NC/ND/SA)."""
    if not license_url:
        return False
    u = license_url.lower()
    if "publicdomain/zero" in u or "publicdomain/mark" in u:
        return True
    # `/by/` matches CC-BY but not `/by-nc/`, `/by-nd/`, `/by-sa/`, `/by-nc-*`.
    return "/licenses/by/" in u


def _clean_scientific_name(raw):
    """Reduce a stored scientific_name to a single GBIF-queryable taxon.

    Handles "Myzus persicae / Aphis gossypii" (take the first), and trailing
    rank noise like "Pseudococcidae family" or "Helopeltis spp.".
    Returns None when nothing usable remains.
    """
    if not raw:
        return None
    name = raw.split("/")[0].strip()
    # Drop parenthetical notes, e.g. "Bactrocera (dorsalis)".
    if "(" in name:
        name = name.split("(")[0].strip()
    tokens = [t for t in name.split() if t.lower().strip(".") not in
              [n.strip(".") for n in _RANK_NOISE]]
    cleaned = " ".join(tokens).strip()
    return cleaned or None


def _find_safe_image(query):
    """Return the first commercial-safe StillImage for a taxon, or None.

    Result dict: {url, license, creator, rights_holder, source, occurrence_key}.
    """
    params = {
        "scientificName": query,
        "mediaType": "StillImage",
        "limit": CANDIDATES_PER_QUERY,
    }
    try:
        resp = requests.get(
            GBIF_SEARCH, params=params,
            headers={"User-Agent": USER_AGENT}, timeout=API_TIMEOUT,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
    except (requests.RequestException, ValueError) as exc:
        frappe.log_error(f"GBIF query failed for {query!r}: {exc}",
                         "fetch_pest_disease_images")
        return None

    for occ in results:
        for media in occ.get("media", []):
            if media.get("type") != "StillImage":
                continue
            fmt = (media.get("format") or "").lower()
            if fmt and not fmt.startswith("image/"):
                continue
            if not _is_commercial_safe(media.get("license")):
                continue
            url = media.get("identifier")
            if not url:
                continue
            return {
                "url": url,
                "license": media.get("license"),
                "creator": media.get("creator") or media.get("rightsHolder") or "",
                "rights_holder": media.get("rightsHolder") or "",
                "source": media.get("references") or url,
                "occurrence_key": occ.get("key"),
            }
    return None


def _download(url):
    """Download image bytes with a size cap. Returns bytes or None."""
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT},
                            timeout=DOWNLOAD_TIMEOUT, stream=True)
        resp.raise_for_status()
        content = resp.content
    except requests.RequestException as exc:
        frappe.log_error(f"Image download failed {url}: {exc}",
                         "fetch_pest_disease_images")
        return None
    if not content or len(content) > MAX_IMAGE_BYTES:
        return None
    return content


def _extension_for(url):
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    return ext if ext in (".jpg", ".jpeg", ".png", ".webp") else ".jpg"


def _attach(doctype, name, content, url):
    """Save `content` as a public File attached to damage_symptoms; set field."""
    from frappe.utils.file_manager import save_file

    safe = frappe.scrub(name)
    fname = f"{safe}{_extension_for(url)}"
    _file = save_file(
        fname, content, doctype, name,
        decode=False, is_private=0, df="damage_symptoms",
    )
    frappe.db.set_value(doctype, name, "damage_symptoms", _file.file_url)
    return _file.file_url


def run(dry_run=False, overwrite=False):
    """Fetch and attach images. See module docstring for invocation."""
    dry_run = frappe.parse_json(dry_run) if isinstance(dry_run, str) else bool(dry_run)
    overwrite = frappe.parse_json(overwrite) if isinstance(overwrite, str) else bool(overwrite)

    attached, skipped_has_image, no_name, no_image, credits = [], [], [], [], []

    for doctype in TARGET_DOCTYPES:
        rows = frappe.get_all(
            doctype,
            fields=["name", "scientific_name", "common_name", "damage_symptoms"],
            order_by="name asc",
        )
        for row in rows:
            label = f"{doctype}: {row.name}"

            if row.damage_symptoms and not overwrite:
                skipped_has_image.append(label)
                continue

            query = _clean_scientific_name(row.scientific_name)
            if not query:
                no_name.append(label)
                continue

            found = _find_safe_image(query)
            if not found:
                no_image.append(f"{label} (searched {query!r})")
                continue

            credit = {
                "doctype": doctype, "record": row.name, "query": query,
                "creator": found["creator"], "license": found["license"],
                "source": found["source"], "image_url": found["url"],
            }

            if dry_run:
                credits.append(credit)
                attached.append(f"[DRY] {label} <- {query} ({found['license']})")
                continue

            content = _download(found["url"])
            if not content:
                no_image.append(f"{label} (download failed for {query!r})")
                continue

            file_url = _attach(doctype, row.name, content, found["url"])
            credit["attached_file"] = file_url
            credits.append(credit)
            attached.append(f"{label} <- {query} ({found['license']})")

    if not dry_run:
        frappe.db.commit()

    manifest_path = _write_manifest(credits, dry_run)
    _print_summary(attached, skipped_has_image, no_name, no_image,
                   manifest_path, dry_run)
    return {
        "attached": len(attached),
        "skipped_has_image": len(skipped_has_image),
        "no_scientific_name": len(no_name),
        "no_safe_image_found": len(no_image),
        "manifest": manifest_path,
        "dry_run": dry_run,
    }


def _write_manifest(credits, dry_run):
    """Write attribution rows to a CSV in the site's public files. Returns path."""
    if not credits:
        return None
    suffix = "dry_run" if dry_run else "attached"
    path = frappe.get_site_path("public", "files",
                                f"pest_disease_image_credits_{suffix}.csv")
    fields = ["doctype", "record", "query", "creator", "license",
              "source", "image_url", "attached_file"]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(credits)
    return path


def _print_summary(attached, skipped, no_name, no_image, manifest_path, dry_run):
    mode = "DRY RUN (no writes)" if dry_run else "LIVE"
    print(f"\n=== fetch_pest_disease_images [{mode}] ===")
    print(f"Attached:            {len(attached)}")
    print(f"Skipped (has image): {len(skipped)}")
    print(f"No scientific name:  {len(no_name)}")
    print(f"No safe image found: {len(no_image)}")
    if manifest_path:
        print(f"Attribution manifest: {manifest_path}")

    def _block(title, items):
        if items:
            print(f"\n{title}:")
            for it in items:
                print(f"  - {it}")

    _block("Attached", attached)
    _block("No usable scientific name (handle manually)", no_name)
    _block("No CC0/CC-BY image found (try common name manually)", no_image)
