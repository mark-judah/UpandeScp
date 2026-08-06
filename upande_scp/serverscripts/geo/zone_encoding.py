"""Compact codec for Zone geometry.

``getBedsAndZones`` currently ships every zone as a full escaped GeoJSON
``FeatureCollection`` string (~273 B each, 154k+ zones = 54.80 MB), but the
frontend reads exactly two things out of it: the 2-point LineString
``coordinates`` and the ``line_id`` property. This module trades that GeoJSON
envelope for a compact per-bed array, exploiting two measured properties of
the real data:

1. Every zone name is exactly ``"<bed name> - Zone <N>"`` — so only the
   number ``N`` need travel, not the whole string (zone names alone are
   5.84 MB of the current payload).
2. ~99% of beds are *contiguous*: zone i's start point is exactly zone i-1's
   end point, within floating-point noise. For a contiguous bed only the
   chain of end points need be sent — the middle-zone start/end pairs are
   implied. Beds that fail that test (any single gap) fall back to explicit
   ``[start, end]`` pairs, one per zone, so nothing is lost.

No Frappe imports here on purpose: this module is pure and unit-testable
on its own; the round-trip guard in
``upande_scp.serverscripts.tests.check_zone_encoding`` exercises it against
every real Zone on kaitet.local.

Coordinates are rounded to 7 decimal places (~1.1 cm at the equator) — well
below anything a rendered map can show, and the rounding the whole scheme's
size savings are measured against.

Wire format
-----------
``encode_beds`` returns a list with one entry per bed::

    [bed_name, line_id, [x0, y0], ends_or_pairs, name_suffixes, contiguous]

- ``bed_name``: the Bed doctype name (str).
- ``line_id``: the shared ``properties.line_id`` value for every zone in
  this bed (int, or whatever the source data carries — never inspected by
  the codec, just passed through), or ``None`` if it could not be
  determined uniquely.
- ``[x0, y0]``: the bed's start point — the *start* of its first zone.
- ``ends_or_pairs`` / ``contiguous``:
    - ``contiguous == 1``: ``ends_or_pairs`` is
      ``[[x1,y1], [x2,y2], ...]``, one point per zone, in zone order. Zone
      *i* (0-indexed) spans ``points[i-1] -> points[i]``, where
      ``points[-1]`` is the bed's start point ``[x0, y0]`` above.
    - ``contiguous == 0``: ``ends_or_pairs`` is
      ``[[[xa,ya],[xb,yb]], ...]``, one explicit ``[start, end]`` pair per
      zone, in zone order. ``[x0, y0]`` is still present (equal to the
      first zone's start) but unused by the decoder in this mode.
- ``name_suffixes``: one entry per zone, in the same order as
  ``ends_or_pairs``. A pure-digit string ``"N"`` means the zone's full name
  is derivable as ``f"{bed_name} - Zone {N}"``; any other string is the
  zone's full, literal name (used verbatim, no reconstruction). This is a
  safe discriminator because no real zone name is only digits.

Input to ``encode_beds`` is a flat iterable of per-zone dicts (order does
not matter — the encoder sorts within each bed):

    {
        "bed": str,           # bed name
        "name": str,          # full zone doctype name
        "line_id": Any,       # properties.line_id from the zone's geojson
        "order": Any,         # sort key giving the zone's position within
                               # its bed (e.g. properties.zone_id); must be
                               # comparable/orderable
        "coords": [[x0, y0], [x1, y1]],  # the zone's 2-point LineString
    }
"""

from __future__ import annotations

_ROUND = 7
_EPS_CONTIGUOUS = 1e-9


def _round_point(pt):
    x, y = pt
    return [round(float(x), _ROUND), round(float(y), _ROUND)]


def _points_equal(a, b, eps=_EPS_CONTIGUOUS):
    return abs(a[0] - b[0]) <= eps and abs(a[1] - b[1]) <= eps


def _name_suffix(bed_name: str, zone_name: str) -> str:
    """The compact form of ``zone_name`` given it belongs to ``bed_name``.

    Returns a pure-digit string when ``zone_name`` is exactly
    ``"<bed_name> - Zone <N>"``; otherwise returns ``zone_name`` unchanged
    (the decoder's job is then to use it verbatim).
    """
    prefix = f"{bed_name} - Zone "
    if zone_name.startswith(prefix):
        rest = zone_name[len(prefix):]
        if rest.isdigit():
            return rest
    return zone_name


def encode_beds(zones) -> list:
    """Encode a flat iterable of per-zone dicts into the compact wire format.

    See the module docstring for the input shape and the resulting wire
    format. Zones are grouped by ``bed`` and sorted by ``order`` before
    contiguity detection, so caller-supplied ordering doesn't matter.
    """
    beds: dict[str, list[dict]] = {}
    for z in zones:
        beds.setdefault(z["bed"], []).append(z)

    out = []
    for bed_name, bed_zones in beds.items():
        bed_zones = sorted(bed_zones, key=lambda z: z["order"])

        rounded = [
            (_round_point(z["coords"][0]), _round_point(z["coords"][1]))
            for z in bed_zones
        ]

        contiguous = True
        for i in range(1, len(rounded)):
            prev_end = rounded[i - 1][1]
            this_start = rounded[i][0]
            if not _points_equal(prev_end, this_start):
                contiguous = False
                break

        start_point = rounded[0][0] if rounded else [0.0, 0.0]

        if contiguous:
            ends_or_pairs = [r[1] for r in rounded]
        else:
            ends_or_pairs = [[r[0], r[1]] for r in rounded]

        name_suffixes = [_name_suffix(bed_name, z["name"]) for z in bed_zones]

        line_ids = {z.get("line_id") for z in bed_zones}
        line_id = line_ids.pop() if len(line_ids) == 1 else None

        out.append([
            bed_name,
            line_id,
            start_point,
            ends_or_pairs,
            name_suffixes,
            1 if contiguous else 0,
        ])

    return out


def decode_bed(entry) -> list:
    """Inverse of one entry from ``encode_beds``.

    Returns ``[{"name": str, "coords": [[x, y], [x, y]], "lineId": Any}, ...]``
    in the same zone order the entry carries.
    """
    bed_name, line_id, start_point, ends_or_pairs, name_suffixes, contiguous = entry

    zones = []
    if contiguous:
        prev = start_point
        for point, suffix in zip(ends_or_pairs, name_suffixes):
            coords = [prev, point]
            name = (
                f"{bed_name} - Zone {suffix}" if suffix.isdigit() else suffix
            )
            zones.append({"name": name, "coords": coords, "lineId": line_id})
            prev = point
    else:
        for pair, suffix in zip(ends_or_pairs, name_suffixes):
            coords = [pair[0], pair[1]]
            name = (
                f"{bed_name} - Zone {suffix}" if suffix.isdigit() else suffix
            )
            zones.append({"name": name, "coords": coords, "lineId": line_id})

    return zones
