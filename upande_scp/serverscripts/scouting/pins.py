"""Scouting Pins (piece 3c, spec 2026-10-10-spread-and-pins C6–C9): an area an
agronomist watches week by week. A pin is a section of the 3 × 3 grid, a
frozen copy of a patch, or an area drawn on the map. Its weekly figure is
infested ÷ scouted among its stations. When that figure jumps, the owner gets
one in-app notice a week (``check_pins``, added with the series).

Visibility (C9): shared pins are listed to everyone who may see the house
(``thresholds_check._assert_can_see``: crop scope + farm); private pins only to
their owner. Changing or deleting one takes its owner, an SCP General Manager
or a System Manager, and the doctype controller enforces that on every path.
"""

import json

import frappe

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import thresholds_check as TC

DOCTYPE = "Scouting Pin"
KINDS = ("Section", "Patch", "Area")
OBS_KINDS = {"pest": "Pest", "disease": "Disease"}
EDIT_ROLES = ("SCP General Manager", "System Manager")
PIN_FIELDS = [
    "name", "title", "crop", "farm", "warehouse", "kind", "observation", "obs_kind", "stage",
    "section_row", "section_col", "stations", "polygon", "source_week", "shared", "notify",
    "last_notified_week", "owner", "creation",
]


def _roles(user) -> set:
    return set(frappe.get_roles(user))


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def may_edit(pin, user=None) -> bool:
    """C9: the owner, an SCP General Manager or a System Manager."""
    user = user or frappe.session.user
    if user == "Administrator" or user == pin.owner:
        return True
    return bool(_roles(user) & set(EDIT_ROLES))


def assert_may_edit(pin, user=None) -> None:
    if not may_edit(pin, user):
        frappe.throw("Only the pin's owner or an SCP General Manager may change or delete it.",
                     frappe.PermissionError)


def _house(crop, warehouse) -> tuple:
    """(canonical crop, farm, warehouse) once the user may see the house."""
    crop = crop_catalog.resolve_crop(crop)
    warehouse = (warehouse or "").strip()
    if not crop or not warehouse:
        frappe.throw("A pin needs a crop and a greenhouse or block.", frappe.ValidationError)
    farm = frappe.db.get_value("Warehouse", warehouse, "custom_farm")
    TC._assert_can_see(crop, farm)
    return crop, farm, warehouse


def _json_list(value) -> list:
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else []
        except ValueError:
            frappe.throw("Stations must be a JSON list of names.", frappe.ValidationError)
    return [str(s).strip() for s in (value or ()) if str(s).strip()]


def pin_stations(pin) -> list:
    """A Section pin's stations come from the current grid (they follow zone
    changes); Patch and Area pins keep the list frozen at save time."""
    if pin.kind == "Section":
        cell = (int(pin.section_row), int(pin.section_col))
        return sorted(st for st, pos in R.station_grid(pin.warehouse).items() if tuple(pos) == cell)
    return _json_list(pin.stations)


def station_centroids(warehouse) -> dict:
    """``{station: (lng, lat)}``: zone centroids (the mean of their bed-line
    points), or tree points on a block. Read once, when an area pin is saved."""
    rows = frappe.db.sql("SELECT name, geojson FROM `tabZone` WHERE greenhouse = %s", (warehouse,))
    if not rows:
        rows = frappe.db.sql("SELECT name, geojson FROM `tabOrchard Tree` WHERE block = %s", (warehouse,))
    out = {}
    for name, raw in rows:
        c = C.geometry_centroid(C.parse_geojson(raw))
        if c:
            out[name] = c
    return out


def _visible(pin, user) -> bool:
    return bool(int(pin.shared or 0)) or pin.owner == user


def _public(pin, user) -> dict:
    return {
        "name": pin.name, "title": pin.title, "crop": pin.crop, "farm": pin.farm,
        "warehouse": pin.warehouse, "kind": pin.kind, "observation": pin.observation or "",
        "obs_kind": pin.obs_kind or "", "stage": pin.stage or "",
        "section_row": pin.section_row, "section_col": pin.section_col,
        "stations": pin_stations(pin),
        "polygon": C.parse_geojson(pin.polygon) if pin.polygon else None,
        "source_week": pin.source_week or "", "shared": int(pin.shared or 0),
        "notify": int(pin.notify or 0), "owner": pin.owner, "may_edit": may_edit(pin, user),
    }


def _visible_rows(crop, warehouse, user) -> list:
    if not frappe.db.table_exists(DOCTYPE):
        return []
    rows = frappe.get_all(DOCTYPE, filters={"crop": crop, "warehouse": warehouse}, fields=PIN_FIELDS,
                          order_by="creation desc", limit_page_length=0)
    return [r for r in rows if _visible(r, user)]


@frappe.whitelist()
def list_pins(crop, warehouse, with_series=0) -> list:
    """C9: the house's pins this user may see: every shared pin plus their
    own private ones, newest first. ``may_edit`` says whether Delete shows."""
    crop, _farm, warehouse = _house(crop, warehouse)
    user = frappe.session.user
    return [_public(r, user) for r in _visible_rows(crop, warehouse, user)]


@frappe.whitelist()
def save_pin(crop, warehouse, kind, title, observation=None, obs_kind=None, stage=None,
             section_row=None, section_col=None, stations=None, polygon=None,
             source_week=None, shared=1, notify=1) -> dict:
    """C6: a Section (row/col of the 3 × 3 grid), a Patch (a frozen list of
    this house's stations) or an Area (a GeoJSON polygon, resolved now to the
    zones / trees whose centroid lies inside it; the polygon is kept for
    drawing). Blank ``observation`` watches every pest and disease."""
    crop, farm, warehouse = _house(crop, warehouse)
    kind = (kind or "").strip().title()
    if kind not in KINDS:
        frappe.throw(f"A pin is a Section, a Patch or an Area, not {kind or 'nothing'}.", frappe.ValidationError)
    title = (title or "").strip()[:140]
    if not title:
        frappe.throw("A pin needs a title.", frappe.ValidationError)
    observation = (observation or "").strip()
    obs_label = ""
    if observation:
        obs_label = OBS_KINDS.get((obs_kind or "").strip().lower(), "")
        if not obs_label:
            frappe.throw("Say whether the pinned observation is a pest or a disease.", frappe.ValidationError)
    doc = {
        "doctype": DOCTYPE, "title": title, "crop": crop, "farm": farm, "warehouse": warehouse,
        "kind": kind, "observation": observation, "obs_kind": obs_label,
        "stage": (stage or "").strip() if observation else "",
        "source_week": (source_week or "").strip(), "section_row": -1, "section_col": -1,
        "shared": 1 if _truthy(shared) else 0, "notify": 1 if _truthy(notify) else 0,
    }
    if kind == "Section":
        try:
            row, col = int(section_row), int(section_col)
        except (TypeError, ValueError):
            row = col = -1
        if not (0 <= row < P.GRID and 0 <= col < P.GRID):
            frappe.throw("A section pin needs a row and a column of the 3 × 3 grid.", frappe.ValidationError)
        doc.update(section_row=row, section_col=col)
    elif kind == "Patch":
        mine = set(R.station_ranks(warehouse))
        picked = sorted({s for s in _json_list(stations) if s in mine})
        if not picked:
            frappe.throw(f"None of those stations is in {warehouse}.", frappe.ValidationError)
        doc["stations"] = json.dumps(picked)
    else:
        geom = C.parse_geojson(polygon)
        if not C.polygons(geom):
            frappe.throw("Draw an area of at least three corners.", frappe.ValidationError)
        picked = C.stations_in_polygon(station_centroids(warehouse), geom)
        if not picked:
            frappe.throw(f"The area you drew holds no zone or tree of {warehouse}.", frappe.ValidationError)
        doc["stations"] = json.dumps(picked)
        doc["polygon"] = json.dumps(geom)
    pin = frappe.get_doc(doc).insert(ignore_permissions=True)
    return _public(pin.as_dict(), frappe.session.user)


@frappe.whitelist()
def delete_pin(name) -> dict:
    """C9: owner, SCP General Manager or System Manager, on a house they may see."""
    pin = frappe.get_doc(DOCTYPE, name)
    _house(pin.crop, pin.warehouse)
    assert_may_edit(pin)
    frappe.delete_doc(DOCTYPE, pin.name, ignore_permissions=True)
    return {"name": pin.name}
