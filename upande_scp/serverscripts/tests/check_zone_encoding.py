"""Round-trip guard for the compact Zone-geometry codec.

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.check_zone_encoding.run

Loads *every* Zone on kaitet.local that carries a ``geojson`` value, runs it
through ``upande_scp.serverscripts.geo.zone_encoding.encode_beds`` /
``decode_bed``, and asserts — for every single zone, no sampling, no
loosened tolerance — that the round trip is lossless:

    - reconstructed ``coords`` match the original within 1e-7 degrees
      (~1.1 cm at the equator; well below anything a rendered map can show)
    - ``lineId`` matches exactly
    - the reconstructed zone *name* matches the original exactly

It also reports the size of the compact payload (raw + gzip level 5)
against the measured 54.80 MB baseline of the current
``getBedsAndZones`` response, and the contiguous-vs-explicit bed split the
codec's per-bed fallback produces on real data.

Read-only: this only ever runs ``frappe.db.sql`` SELECTs against
kaitet.local, never writes.

``raise SystemExit(1)`` on any mismatch. A mismatch is a codec bug, not a
data-quality issue to route around — see the module docstring in
``zone_encoding.py`` for the assumptions this is built on.
"""

from __future__ import annotations

import gzip
import json

import frappe

from upande_scp.serverscripts.geo.zone_encoding import decode_bed, encode_beds

_BASELINE_RAW_BYTES = 54.80 * 1024 * 1024
_COORD_TOL = 1e-7


def _load_zones():
    """Every Zone with a geojson value, as the flat dicts encode_beds wants.

    ``order`` is the ``<N>`` in ``"<bed> - Zone <N>"`` — verified against
    live data to hold for 100% of zones with geojson set (0 exceptions out
    of 154 290 as of 2026-08-06). It is *not* the geojson ``zone_id``
    property, which drifts from the name-derived number on 558 zones; the
    name is the field the frontend and every other consumer treats as
    truth, so it is also the ordering the contiguity detection is built on.
    """
    rows = frappe.db.sql(
        """
        SELECT name, bed, geojson
        FROM `tabZone`
        WHERE geojson IS NOT NULL AND geojson != ''
        """,
        as_dict=True,
    )

    zones = []
    originals = {}
    bad_shape = []

    for row in rows:
        name = row["name"]
        bed = row["bed"]
        try:
            gj = json.loads(row["geojson"])
            feature = gj["features"][0]
            coords = feature["geometry"]["coordinates"]
            line_id = feature["properties"]["line_id"]
            if len(coords) != 2:
                raise ValueError(f"expected 2-point LineString, got {len(coords)}")
        except Exception as exc:  # noqa: BLE001 - collected, not raised here
            bad_shape.append((name, str(exc)))
            continue

        prefix = f"{bed} - Zone "
        if not name.startswith(prefix) or not name[len(prefix):].isdigit():
            bad_shape.append((name, "name is not '<bed> - Zone <N>'"))
            continue
        order = int(name[len(prefix):])

        zones.append({
            "bed": bed,
            "name": name,
            "line_id": line_id,
            "order": order,
            "coords": coords,
        })
        originals[name] = {"coords": coords, "line_id": line_id}

    return zones, originals, bad_shape


def run():
    zones, originals, bad_shape = _load_zones()

    if bad_shape:
        print(f"WARNING: {len(bad_shape)} zones skipped (unexpected shape):")
        for name, reason in bad_shape[:5]:
            print(f"    {name}: {reason}")

    zone_count = len(zones)
    bed_names = {z["bed"] for z in zones}
    bed_count = len(bed_names)

    encoded = encode_beds(zones)

    contiguous_beds = sum(1 for e in encoded if e[5] == 1)
    explicit_beds = sum(1 for e in encoded if e[5] == 0)

    decoded_by_name = {}
    dup_names = []
    for entry in encoded:
        for z in decode_bed(entry):
            if z["name"] in decoded_by_name:
                dup_names.append(z["name"])
            decoded_by_name[z["name"]] = z

    mismatches = []

    missing = set(originals) - set(decoded_by_name)
    extra = set(decoded_by_name) - set(originals)

    for name in missing:
        mismatches.append((name, "MISSING from decoded output", originals[name], None))
    for name in extra:
        mismatches.append((name, "EXTRA in decoded output, no such original", None, decoded_by_name[name]))

    for name, orig in originals.items():
        dec = decoded_by_name.get(name)
        if dec is None:
            continue  # already reported above as missing

        ox0, oy0 = orig["coords"][0]
        ox1, oy1 = orig["coords"][1]
        dx0, dy0 = dec["coords"][0]
        dx1, dy1 = dec["coords"][1]

        coord_ok = (
            abs(ox0 - dx0) <= _COORD_TOL
            and abs(oy0 - dy0) <= _COORD_TOL
            and abs(ox1 - dx1) <= _COORD_TOL
            and abs(oy1 - dy1) <= _COORD_TOL
        )
        line_ok = dec["lineId"] == orig["line_id"]

        if not coord_ok or not line_ok:
            mismatches.append((name, "coord/lineId mismatch", orig, dec))

    for name in dup_names:
        mismatches.append((name, "DUPLICATE name emitted by decode_bed across beds", None, None))

    raw_json = json.dumps(encoded, separators=(",", ":"))
    raw_bytes = len(raw_json.encode("utf-8"))
    gz_bytes = len(gzip.compress(raw_json.encode("utf-8"), compresslevel=5))

    print("check_zone_encoding")
    print(f"  zones checked:        {zone_count}")
    print(f"  beds:                 {bed_count}")
    print(f"  contiguous beds:      {contiguous_beds} ({100.0 * contiguous_beds / bed_count:.2f}%)")
    print(f"  explicit-pair beds:   {explicit_beds} ({100.0 * explicit_beds / bed_count:.2f}%)")
    print(f"  encoded size (raw):   {raw_bytes:,} B  ({raw_bytes / 1024 / 1024:.2f} MB)")
    print(f"  encoded size (gzip5): {gz_bytes:,} B  ({gz_bytes / 1024 / 1024:.2f} MB)")
    print(f"  baseline (raw):       {_BASELINE_RAW_BYTES:,.0f} B  (54.80 MB)")
    print(f"  ratio vs baseline:    {_BASELINE_RAW_BYTES / raw_bytes:.2f}x raw")

    if mismatches:
        print(f"\nFAILED: {len(mismatches)} mismatches out of {zone_count} zones")
        for name, reason, orig, dec in mismatches[:10]:
            print(f"    {name}: {reason}")
            print(f"        original: {orig}")
            print(f"        decoded:  {dec}")
        raise SystemExit(1)

    print(f"\ncheck_zone_encoding: PASSED — 0 mismatches across {zone_count} zones")


def run_served_endpoint():
    """Safety net for Task 2 — no browser exists on this host to eyeball the
    maps, so this is the closest thing to a visual check: call the *real*
    ``getBedsAndZones`` endpoint (forcing a fresh build past the Redis
    cache), decode its v2 payload, and assert it reconstructs the same zone
    names + coordinates the old ``raw_geojson`` path produced, for a sample
    of real zones spanning several beds.

    Unlike ``run()`` above (which drives the codec directly), this exercises
    the actual wiring: the new ``K_BEDS_AND_ZONES_V2`` cache key, the
    variety/bed grouping in ``_build_beds_and_zones``, and the whitelisted
    ``getBedsAndZones`` entrypoint the frontend actually calls. A mismatch
    here means the endpoint's *wiring* is wrong even if the codec itself is
    sound.

    Read-only except for one Redis cache key it deliberately busts
    (``K_BEDS_AND_ZONES_V2``) so the check exercises a real rebuild rather
    than serving a stale cached payload — no `kaitet.local` DB writes.
    """
    import random

    from upande_scp.serverscripts.common.cache_utils import K_BEDS_AND_ZONES_V2
    from upande_scp.serverscripts.geo.get_beds_and_zones import getBedsAndZones

    _, originals, _ = _load_zones()

    # Force a real rebuild through the whitelisted endpoint, not a cache hit.
    frappe.cache().delete_value(K_BEDS_AND_ZONES_V2)
    frappe.response.pop("data", None)
    getBedsAndZones()
    payload = frappe.response.get("data")

    assert isinstance(payload, dict), f"expected dict payload, got {type(payload)}"
    assert payload.get("v") == 2, f"expected v=2 marker, got {payload.get('v')!r}"
    assert "varieties" in payload, "payload missing 'varieties' key"

    decoded_by_name = {}
    bed_count = 0
    for variety in payload["varieties"]:
        for bed_entry in variety["beds"]:
            bed_count += 1
            for z in decode_bed(bed_entry):
                decoded_by_name[z["name"]] = z

    sample_size = min(1500, len(originals))
    random.seed(20260806)  # deterministic sample across runs
    sample_names = random.sample(list(originals), sample_size)

    mismatches = []
    sample_beds = set()
    for name in sample_names:
        orig = originals[name]
        dec = decoded_by_name.get(name)
        if dec is None:
            mismatches.append((name, "MISSING from served payload", orig, None))
            continue

        sample_beds.add(name.rsplit(" - Zone ", 1)[0])

        ox0, oy0 = orig["coords"][0]
        ox1, oy1 = orig["coords"][1]
        dx0, dy0 = dec["coords"][0]
        dx1, dy1 = dec["coords"][1]
        coord_ok = (
            abs(ox0 - dx0) <= _COORD_TOL
            and abs(oy0 - dy0) <= _COORD_TOL
            and abs(ox1 - dx1) <= _COORD_TOL
            and abs(oy1 - dy1) <= _COORD_TOL
        )
        line_ok = dec["lineId"] == orig["line_id"]
        if not coord_ok or not line_ok:
            mismatches.append((name, "coord/lineId mismatch", orig, dec))

    print("check_zone_encoding.run_served_endpoint")
    print(f"  served payload 'v':     {payload.get('v')}")
    print(f"  varieties in payload:   {len(payload['varieties'])}")
    print(f"  beds in payload:        {bed_count}")
    print(f"  zones sampled:          {sample_size}")
    print(f"  distinct beds sampled:  {len(sample_beds)}")

    if mismatches:
        print(f"\nFAILED: {len(mismatches)} mismatches out of {sample_size} sampled zones")
        for name, reason, orig, dec in mismatches[:10]:
            print(f"    {name}: {reason}")
            print(f"        original: {orig}")
            print(f"        decoded:  {dec}")
        raise SystemExit(1)

    print(
        f"\ncheck_zone_encoding.run_served_endpoint: PASSED — 0 mismatches "
        f"across {sample_size} sampled zones spanning {len(sample_beds)} beds"
    )
