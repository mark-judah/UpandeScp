"""The standard triangle side for Hexa layouts, and the check imports run on it.

A hexa is six equilateral triangles meeting at the centre, so a full triangle's
ring is `[centre, a, b, centre]` with all three sides equal to the layout's side.
The site sets that side once (`triad_side_m`); an import whose full triangles
differ by more than 2 % is refused whole, rather than half-loaded at the wrong
size. Edge pieces clipped to a field outline are not triangles and are exempt.
"""

import math

import frappe

DEFAULT_SIDE_M = 5.0
TOLERANCE = 0.02
M_PER_DEG = 111320.0


def standard_side_m() -> float:
    """The site's standard side in metres; 5 when the setting is blank or 0."""
    value = frappe.db.get_single_value("Scouting and Crop Protection Settings", "triad_side_m")
    try:
        value = float(value or 0)
    except (TypeError, ValueError):
        value = 0.0
    return value if value > 0 else DEFAULT_SIDE_M


def _dist_m(a, b, lat0):
    dx = (b[0] - a[0]) * M_PER_DEG * math.cos(math.radians(lat0))
    dy = (b[1] - a[1]) * M_PER_DEG
    return math.hypot(dx, dy)


def triangle_side_m(ring_lnglat):
    """Mean side in metres if `ring_lnglat` is a closed 4-point equilateral
    triangle (each side within 2 % of the mean), else None (a clipped piece)."""
    try:
        pts = [(float(p[0]), float(p[1])) for p in ring_lnglat or []]
    except (TypeError, ValueError, IndexError):
        return None
    if len(pts) != 4 or pts[0] != pts[3]:
        return None
    lat0 = sum(p[1] for p in pts[:3]) / 3
    sides = [_dist_m(pts[i], pts[i + 1], lat0) for i in range(3)]
    sides.append(_dist_m(pts[2], pts[0], lat0))
    sides = [sides[0], sides[1], sides[3]]
    mean = sum(sides) / 3
    if mean <= 0 or any(abs(s - mean) > TOLERANCE * mean for s in sides):
        return None
    return mean


def check_side(ring_lnglat, standard: float):
    """None if the ring is fine (on standard, or not a full triangle), else the
    refusal text naming the measured and standard sides."""
    measured = triangle_side_m(ring_lnglat)
    if measured is None or abs(measured - standard) <= TOLERANCE * standard:
        return None
    return (
        f"Triangle side {measured:.2f} m differs from the standard {standard:g} m (±2 %)."
    )
