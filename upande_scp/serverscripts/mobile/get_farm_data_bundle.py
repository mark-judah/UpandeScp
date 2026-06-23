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

from upande_scp.serverscripts.cache_utils import (
    K_SM_FARM_BUNDLE_PREFIX,
    TTL_MEDIUM,
    get_or_set,
)


_BED_FIELDS = ["name", "bed", "greenhouse"]
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
def getFarmDataBundle(farm=None, version=None):
    """Return the cached bundle for a farm.

    Args:
        farm: Farm name (e.g. "Lokitela").
        version: Optional digest from the client's last successful download.
            When it matches the current digest we short-circuit with
            `{"unchanged": true}` so the app skips re-caching everything.

    Response shape:
        {
            "data": {
                "farm": "Lokitela",
                "version": "...",
                "unchanged": False,
                "warehouses": [{...}, ...],
                "sections": [{"name": "...", "warehouse_name": "..."}, ...],
                "station_type": "Block" | "Greenhouse" | None,
                "has_sections": True | False,
                "beds_by_warehouse": {wh_name: [{...}, ...]},
                "traps_by_warehouse": {wh_name: [{...}, ...]},
            }
        }
    """
    if not farm:
        frappe.response["message"] = {"data": None}
        return frappe.response["message"]

    key = f"{K_SM_FARM_BUNDLE_PREFIX}:{farm}"
    bundle = get_or_set(key, lambda: _build_farm_bundle(farm), ttl=TTL_MEDIUM)

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


def _build_farm_bundle(farm: str) -> dict:
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"custom_farm": farm, "disabled": 0},
        fields=_WAREHOUSE_FIELDS,
        limit_page_length=0,
        order_by="lft asc",
    )

    # Stations are the warehouses that beds and traps link to: the leaf
    # warehouses (is_group=0) that greenhouse beds and traps reference.
    station_names = [
        w.name for w in warehouses
        if not w.is_group
    ]
    sections = [
        {"name": w.name, "warehouse_name": w.warehouse_name}
        for w in warehouses
        if w.is_group and w.warehouse_type == "Section"
    ]

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
                {"name": b.name, "bed": b.bed}
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

    return {
        "farm": farm,
        "version": version,
        "unchanged": False,
        "warehouses": [dict(w) for w in warehouses],
        "sections": sections,
        "station_type": station_type,
        "has_sections": len(sections) > 0,
        "beds_by_warehouse": beds_by_warehouse,
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
    """Digest = max(modified) across Warehouse / Bed / Trap for this farm.

    Cheap (3 indexed MAX queries) and changes the moment any underlying
    record is touched, which lines up with our doc_event invalidator.
    """
    parts: list[str] = []

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
