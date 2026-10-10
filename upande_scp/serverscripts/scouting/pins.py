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
from datetime import timedelta

import frappe

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import crop_catalog, notifications
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import thresholds_check as TC

DOCTYPE = "Scouting Pin"
KINDS = ("Section", "Patch", "Area")
OBS_KINDS = {"pest": "Pest", "disease": "Disease"}
EDIT_ROLES = ("SCP General Manager", "System Manager")
#: C7: the Pins panel's sparkline, over the house's last scouted weeks.
SERIES_WEEKS = 8
#: How far back the series looks for those weeks (16 ISO weeks).
SERIES_LOOKBACK_DAYS = 16 * 7
#: A drawn area is a hand-drawn shape: more corners than this is a mistake or abuse.
MAX_VERTICES = 500
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


def _check_house(crop, warehouse) -> tuple:
    """(canonical crop, farm, warehouse) once the warehouse exists and belongs
    to the crop. No visibility test: the doctype controller runs this on every
    insert and save, whoever the user is."""
    crop = crop_catalog.resolve_crop(crop)
    warehouse = (warehouse or "").strip()
    if not crop or not warehouse:
        frappe.throw("A pin needs a crop and a greenhouse or block.", frappe.ValidationError)
    farm = frappe.db.get_value("Warehouse", warehouse, "custom_farm")
    if not farm:
        frappe.throw(f"{warehouse} is not a greenhouse or block of a farm.", frappe.ValidationError)
    if crop_catalog.crop_for_farm(farm) != crop:
        frappe.throw(f"{warehouse} is not a {crop} house.", frappe.ValidationError)
    return crop, farm, warehouse


def _house(crop, warehouse) -> tuple:
    """``_check_house`` plus: the user may see the house (crop scope + farm)."""
    crop, farm, warehouse = _check_house(crop, warehouse)
    TC._assert_can_see(crop, farm)
    return crop, farm, warehouse


def normalise(pin) -> None:
    """Controller hook: whatever the path (endpoint, Desk, script), the farm is
    the house's, and kind, cell and stations are in range and this house's."""
    pin.crop, pin.farm, pin.warehouse = _check_house(pin.crop, pin.warehouse)
    if pin.kind not in KINDS:
        frappe.throw(f"A pin is a Section, a Patch or an Area, not {pin.kind or 'nothing'}.", frappe.ValidationError)
    if pin.kind == "Section":
        row, col = int(pin.section_row if pin.section_row is not None else -1), int(
            pin.section_col if pin.section_col is not None else -1)
        if not (0 <= row < P.GRID and 0 <= col < P.GRID):
            frappe.throw("A section pin needs a row and a column of the 3 × 3 grid.", frappe.ValidationError)
        return
    pin.section_row = pin.section_col = -1
    mine = set(R.station_ranks(pin.warehouse))
    picked = sorted({s for s in _json_list(pin.stations) if s in mine})
    if not picked:
        frappe.throw(f"None of those stations is in {pin.warehouse}.", frappe.ValidationError)
    pin.stations = json.dumps(picked)


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
def list_pins(crop, warehouse, with_series=1, weeks=SERIES_WEEKS) -> list:
    """C9: the house's pins this user may see: every shared pin plus their
    own private ones, newest first. ``may_edit`` says whether Delete shows.
    With ``with_series`` every pin carries its last ``weeks`` scouted weeks
    (C7), all from one scouting load for the house."""
    crop, _farm, warehouse = _house(crop, warehouse)
    user = frappe.session.user
    rows = _visible_rows(crop, warehouse, user)
    out = [_public(r, user) for r in rows]
    if _truthy(with_series) and rows:
        series = _series_for(crop, warehouse, rows, TC.now_eat().date(), _weeks(weeks))
        for p in out:
            p["series"] = series.get(p["name"], [])
    return out


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
        if sum(len(ring) for poly in C.polygons(geom) for ring in poly) > MAX_VERTICES:
            frappe.throw(f"An area may have at most {MAX_VERTICES} corners.", frappe.ValidationError)
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


# ── the weekly figure (C7) ─────────────────────────────────────────────────


def _weeks(n) -> int:
    try:
        return max(1, min(16, int(n)))
    except (TypeError, ValueError):
        return SERIES_WEEKS


def _infested(weeks, pin, week) -> set:
    """The pin's observation (one stage when it names one), or every pest and
    disease when it names none."""
    obs = (pin.observation or "").strip()
    if obs:
        kind = (pin.obs_kind or "Pest").strip().lower()
        return weeks.infested_set(pin.warehouse, week, kind, obs, (pin.stage or "").strip() or R.ANY)
    return weeks.infested_set(pin.warehouse, week, "pest") | weeks.infested_set(pin.warehouse, week, "disease")


def _figure(weeks, pin, stations, week) -> dict:
    return C.share(stations, weeks.scouted_set(pin.warehouse, week), _infested(weeks, pin, week))


def _series_for(crop, warehouse, pins, today, n=SERIES_WEEKS) -> dict:
    """``{pin: [{"week", "scouted", "infested", "value", "thin"}]}`` over the
    house's last ``n`` scouted weeks within 16 weeks of ``today``. A week the
    house was scouted but the pin's stations were not reads scouted 0, thin."""
    if not pins:
        return {}
    start = (today - timedelta(days=SERIES_LOOKBACK_DAYS - 1)).isoformat()
    weeks = R.StationWeeks.load(start, today.isoformat(), crop, [warehouse], lookback_days=0, weeks=R.WINDOW)
    labels = weeks.weeks(warehouse)[-n:]
    out = {}
    for pin in pins:
        stations = pin_stations(pin)
        out[pin.name] = [{"week": w, **_figure(weeks, pin, stations, w)} for w in labels]
    return out


@frappe.whitelist()
def pin_series(name, weeks=SERIES_WEEKS) -> list:
    """One pin's last ``weeks`` scouted weeks (C7), for whoever may see it."""
    pin = frappe.db.get_value(DOCTYPE, name, PIN_FIELDS, as_dict=True)
    if not pin:
        frappe.throw(f"No Scouting Pin {name}.", frappe.DoesNotExistError)
    crop, _farm, warehouse = _house(pin.crop, pin.warehouse)
    if not _visible(pin, frappe.session.user):
        frappe.throw("This pin is private.", frappe.PermissionError)
    return _series_for(crop, warehouse, [pin], TC.now_eat().date(), _weeks(weeks)).get(pin.name, [])


# ── the owner's notice (C8) ────────────────────────────────────────────────


def _notify_owner(pin, now, before, week) -> bool:
    what = pin.observation or "every pest and disease"
    rise = round(now["value"] - before["value"], 1)
    subject = (
        f"Pin {pin.title} in {pin.warehouse}: {what} {now['value']}% (was {before['value']}%) — "
        f"up {rise} points in {week}"
    )
    body = (
        f"{subject}. {now['infested']} of {now['scouted']} stations infested, "
        f"{before['infested']} of {before['scouted']} the scouted week before."
    )
    return bool(notifications.notify(
        [pin.owner], subject, body, DOCTYPE, pin.name, category="scouting", link=TC.dashboard_link(pin.crop),
    ))


def _owner_sees(pin) -> bool:
    """The owner may have lost the farm or crop since they pinned: a notice
    must not leak a house they can no longer see."""
    previous = frappe.session.user
    try:
        frappe.set_user(pin.owner)
        TC._assert_can_see(pin.crop, pin.farm)
        return True
    except frappe.PermissionError:
        return False
    finally:
        frappe.set_user(previous)


def _check_one(weeks, pin) -> bool:
    latest, previous = weeks.latest_pair(pin.warehouse)
    if not latest or not previous or pin.last_notified_week == latest:
        return False
    stations = pin_stations(pin)
    now = _figure(weeks, pin, stations, latest)
    before = _figure(weeks, pin, stations, previous)
    if not C.pin_rises(before, now) or not _owner_sees(pin) or not _notify_owner(pin, now, before, latest):
        return False
    # set_value, not save: validate re-checks the house, and a pin whose house
    # changed must not block its own notice.
    frappe.db.set_value(DOCTYPE, pin.name, "last_notified_week", latest, update_modified=False)
    return True


def check_pins(today=None) -> dict:
    """C8, hourly after the alerts. For each pin with ``notify`` it compares the
    figure in the house's latest scouted week (last 14 days, the alerts'
    window) with the previous scouted week. A rise of >= 10 points, with >= 5
    stations scouted both weeks, tells the owner in-app (category "scouting"),
    at most once per ISO week (``last_notified_week``). One scouting load per
    crop. A failing crop or pin is logged and never stops the others."""
    if not frappe.db.table_exists(DOCTYPE):
        return {"pins": 0, "notified": 0}
    today = today or TC.now_eat().date()
    rows = frappe.get_all(DOCTYPE, filters={"notify": 1}, fields=PIN_FIELDS, limit_page_length=0)
    by_crop: dict = {}
    for r in rows:
        by_crop.setdefault(r.crop, []).append(r)
    start = (today - timedelta(days=TC.EVAL_WINDOW_DAYS - 1)).isoformat()
    told = 0
    for crop, pins in sorted(by_crop.items()):
        try:
            weeks = R.StationWeeks.load(start, today.isoformat(), crop, sorted({p.warehouse for p in pins}))
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"pin check: {crop}")
            continue
        for pin in pins:
            try:
                told += 1 if _check_one(weeks, pin) else 0
            except Exception:
                frappe.log_error(frappe.get_traceback(), f"pin check: {pin.name}")
    return {"pins": len(rows), "notified": told}
