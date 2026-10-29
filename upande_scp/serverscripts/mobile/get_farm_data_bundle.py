"""Bulk farm data bundle for the mobile configure flow.

The previous flow made 2 HTTP calls per leaf (fetchGreenhouseBeds +
fetchTraps), which is 176 round-trips for a 88-block farm like Lokitela.
This endpoint returns one payload with everything the offline cache
needs: warehouses, sections, beds keyed by warehouse, and traps keyed by
warehouse. The result is Redis-cached per farm and rebuilt only when
underlying Bed / Trap / Warehouse / Farm records change (see
`cache_utils.invalidate_on_change`).

Clients pass `version` on subsequent requests; the server returns
`{"unchanged": true}` when the digest matches so the app can skip the
payload entirely.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.common import farm_map
from upande_scp.serverscripts.mobile.get_farm_hierarchy_info import derive_levels

from upande_scp.serverscripts.common.cache_utils import (
    K_SM_FARM_BUNDLE_PREFIX,
    TTL_MEDIUM,
    get_or_set,
)


# `unit_type` distinguishes a rose bed from an avocado row from a coffee band.
# They all live in `tabBed`, so without it the phone cannot label a unit or tell
# which scouting screen applies. See `field_unit_automation.py`.
_BED_FIELDS = ["name", "bed", "greenhouse", "unit_type"]

# Bumped whenever the payload's *shape* changes. The version digest is otherwise
# derived purely from `modified` timestamps, so a phone holding a bundle from
# before a new field existed would never learn it was missing one.
_BUNDLE_SCHEMA = "v3-levels"
_TRAP_FIELDS = ["name", "farm", "greenhouse", "trap_number", "location", "type"]
_WAREHOUSE_FIELDS = [
    "name",
    "warehouse_name",
    "warehouse_type",
    "is_group",
    "parent_warehouse",
    "custom_farm",
    "disabled",
]


@frappe.whitelist()
def getFarmDataBundle(farm=None, version=None, crop=None):
    """Return the cached bundle for a farm.

    Args:
        farm: Farm name (e.g. "Lokitela").
        version: Optional digest from the client's last successful download.
            When it matches the current digest we short-circuit with
            `{"unchanged": true}` so the app skips re-caching everything.
        crop: Optional crop name. When given, stations whose crop today is not
            this crop are left out (with their beds and traps).

    Response shape:
        {
            "data": {
                "farm": "Lokitela",
                "version": "...",
                "unchanged": False,
                "warehouses": [{..., "crop": "Roses" | None}, ...],  # stations carry crop
                "sections": [{"name": "...", "warehouse_name": "..."}, ...],
                "levels": [{"name", "warehouse_name", "warehouse_type", "parent"}, ...],
                "station_type": "Block" | "Greenhouse" | None,
                "has_sections": True | False,
                "beds_by_warehouse": {wh_name: [{name, bed, unit_type}, ...]},
            "unit_type_by_warehouse": {wh_name: "Bed" | "Row" | "Band"},
                "traps_by_warehouse": {wh_name: [{...}, ...]},
            }
        }
    """
    if not farm:
        frappe.response["message"] = {"data": None}
        return frappe.response["message"]

    key = f"{K_SM_FARM_BUNDLE_PREFIX}:{farm}"
    bundle = get_or_set(key, lambda: _build_farm_bundle(farm), ttl=TTL_MEDIUM)

    # Crop is resolved for today, so it is layered on per request and never
    # stored in the cached bundle (a planting can start overnight).
    bundle = _with_crops(bundle, crop)

    if version and bundle.get("version") and version == bundle["version"]:
        frappe.response["message"] = {
            "data": {
                "farm": farm,
                "version": bundle["version"],
                "unchanged": True,
            }
        }
        return frappe.response["message"]

    frappe.response["message"] = {"data": bundle}
    return frappe.response["message"]


def _crops_for(names: list[str]) -> dict:
    """Today's crop per station, in one batched call. Empty if planting is absent."""
    if not names:
        return {}
    try:
        from upande_scp.serverscripts.common import planting
    except ImportError:
        return {}
    return planting.crops_for_stations(names) or {}


def _with_crops(bundle: dict, crop=None) -> dict:
    """Copy of ``bundle`` whose stations carry ``crop``; filtered if ``crop`` given."""
    types = farm_map.station_types()
    warehouses = [dict(w) for w in bundle.get("warehouses", [])]
    stations = [w["name"] for w in warehouses if farm_map.is_station(w, types)]
    crops = _crops_for(stations)
    for w in warehouses:
        if w["name"] in crops or w["name"] in stations:
            w["crop"] = crops.get(w["name"])
            w["parent"] = w.get("parent_warehouse")

    out = dict(bundle)
    if crop:
        keep = {n for n in stations if crops.get(n) == crop}
        drop = set(stations) - keep
        warehouses = [w for w in warehouses if w["name"] not in drop]
        out["beds_by_warehouse"] = {
            k: v for k, v in bundle.get("beds_by_warehouse", {}).items() if k in keep
        }
        out["traps_by_warehouse"] = {
            k: v for k, v in bundle.get("traps_by_warehouse", {}).items() if k in keep
        }
        out["unit_type_by_warehouse"] = {
            k: v for k, v in bundle.get("unit_type_by_warehouse", {}).items() if k in keep
        }
        # Keep only the pickers that still lead to a station.
        wanted = set()
        by_name = {w["name"]: w for w in warehouses}
        for n in keep:
            p = by_name[n].get("parent_warehouse")
            while p and p in by_name and p not in wanted:
                wanted.add(p)
                p = by_name[p].get("parent_warehouse")
        out["levels"] = [l for l in bundle.get("levels", []) if l["name"] in wanted]
        direct = {by_name[n].get("parent_warehouse") for n in keep}
        out["sections"] = [s for s in bundle.get("sections", []) if s["name"] in direct]
        out["has_sections"] = len(out["sections"]) > 0
        out["version"] = f"{bundle.get('version')}|crop={crop}"
    out["warehouses"] = warehouses
    return out


def _build_farm_bundle(farm: str) -> dict:
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"custom_farm": farm, "disabled": 0},
        fields=_WAREHOUSE_FIELDS,
        limit_page_length=0,
        order_by="lft asc",
    )

    # Stations are the warehouses that beds and traps link to, and they are
    # chosen by *type* — not by "everything that is not a group".
    #
    # That older rule handed the phone every non-group warehouse on the farm:
    # chemical stores, CSUs, transit, and `Torongo GH18 - KR`, a stock-only
    # warehouse with no type and no beds. A scout picked it and lost six days of
    # captures to `Could not find Bed`. `farm_map.is_station` keeps Block groups
    # (an orchard block carries its rows beneath it) and drops the rest.
    station_types = farm_map.station_types()
    station_names = [
        w.name for w in warehouses if farm_map.is_station(w, station_types)
    ]
    farm_wh = frappe.db.get_value(
        "Warehouse", {"warehouse_type": "Farm", "custom_farm": farm}, "name"
    )
    sections, levels = derive_levels(
        farm_wh, [dict(w) for w in warehouses], station_types
    )

    beds_by_warehouse: dict[str, list] = {}
    traps_by_warehouse: dict[str, list] = {}

    if station_names:
        beds = frappe.get_all(
            "Bed",
            filters={"greenhouse": ["in", station_names]},
            fields=_BED_FIELDS,
            limit_page_length=0,
            order_by="bed asc",
        )
        for b in beds:
            beds_by_warehouse.setdefault(b.greenhouse, []).append(
                {
                    "name": b.name,
                    "bed": b.bed,
                    # Defaults to Bed for the rose records that predate the field.
                    "unit_type": b.unit_type or "Bed",
                }
            )

        traps = frappe.get_all(
            "Trap",
            filters={"greenhouse": ["in", station_names]},
            fields=_TRAP_FIELDS,
            limit_page_length=0,
            order_by="trap_number asc",
        )
        for t in traps:
            traps_by_warehouse.setdefault(t.greenhouse, []).append(dict(t))

    station_type = _infer_station_type(warehouses)
    version = _compute_farm_version(farm, station_names)

    # What one unit is called in each warehouse, so the app can label a picker
    # "Bands" without scanning every unit. A warehouse holds one kind — core
    # validates beds onto Greenhouses and rows/bands onto Blocks — so the first
    # unit settles it.
    unit_type_by_warehouse = {
        wh: units[0]["unit_type"] for wh, units in beds_by_warehouse.items() if units
    }

    return {
        "farm": farm,
        "version": version,
        "unchanged": False,
        "warehouses": [dict(w) for w in warehouses],
        "sections": sections,
        "levels": levels,
        "station_type": station_type,
        "has_sections": len(sections) > 0,
        "beds_by_warehouse": beds_by_warehouse,
        "unit_type_by_warehouse": unit_type_by_warehouse,
        "traps_by_warehouse": traps_by_warehouse,
    }


def _infer_station_type(warehouses) -> str | None:
    """Pick the dominant station warehouse_type (Greenhouse vs Block).

    Group Block warehouses count too — a block can be is_group=1 when it has
    row sub-warehouses, but it's still the scouting station the app needs.
    """
    counts: dict[str, int] = {}
    for w in warehouses:
        wt = w.warehouse_type
        if wt == "Greenhouse" and not w.is_group:
            counts[wt] = counts.get(wt, 0) + 1
        elif wt == "Block":
            counts[wt] = counts.get(wt, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _compute_farm_version(farm: str, station_names: list[str]) -> str:
    """Digest = schema stamp + max(modified) across Warehouse / Bed / Trap.

    Cheap (3 indexed MAX queries) and changes the moment any underlying record is
    touched, which lines up with our doc_event invalidator. The schema stamp
    covers the case timestamps cannot: adding a field to the payload, where the
    data is unchanged but what the phone holds is now incomplete.
    """
    parts: list[str] = [_BUNDLE_SCHEMA]

    wh_max = frappe.db.sql(
        "SELECT MAX(modified) FROM `tabWarehouse` WHERE custom_farm = %s",
        (farm,),
    )
    parts.append(_digest_part(wh_max))

    if station_names:
        bed_max = frappe.db.sql(
            "SELECT MAX(modified) FROM `tabBed` WHERE greenhouse IN %(names)s",
            {"names": tuple(station_names)},
        )
        parts.append(_digest_part(bed_max))

        trap_max = frappe.db.sql(
            "SELECT MAX(modified) FROM `tabTrap` WHERE greenhouse IN %(names)s",
            {"names": tuple(station_names)},
        )
        parts.append(_digest_part(trap_max))
    else:
        parts.extend(["0", "0"])

    return "|".join(parts)


def _digest_part(rows) -> str:
    if not rows or not rows[0] or rows[0][0] is None:
        return "0"
    return str(rows[0][0])
