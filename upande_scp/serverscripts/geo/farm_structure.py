"""The farm's land hierarchy as one tree, for the structure mind-map.

Farms describe the levels above the field unit freely, per branch: each node is
a Warehouse with a `warehouse_type` linked by `parent_warehouse` and scoped by
`custom_farm`. The bottom is a fixed pair kept in upande_core: Bed -> Zone,
Row -> Tree, Hexa -> Triad. This reads both halves in a handful of queries and
returns the tree plus the distinct type paths that hold units.
"""

import frappe
from frappe.utils import now_datetime

CACHE_TTL = 600
PAIR = {"Bed": "Zone", "Row": "Tree", "Hexa": "Triad"}
TRIADS_PER_HEXA = 6
NO_TYPE = "(no type)"
UNKNOWN = "Unknown"
STATION_TYPES = ("Greenhouse", "Block")


def _cache_key(farm):
    return f"scp:farm_structure:{farm}"


@frappe.whitelist()
def get_farm_structure(farm: str, refresh: int = 0) -> dict:
    frappe.has_permission("Warehouse", "read", throw=True)
    key = _cache_key(farm)
    if not int(refresh or 0):
        cached = frappe.cache.get_value(key)
        if cached:
            return cached
    result = _build(farm)
    frappe.cache.set_value(key, result, expires_in_sec=CACHE_TTL)
    return result


def _unit_counts(stations):
    """{station: {kind: {"units", "children", "edge"}}} in a few grouped queries."""
    out = {}
    if not stations:
        return out

    def slot(station, kind):
        return out.setdefault(station, {}).setdefault(
            kind, {"units": 0, "children": 0, "edge": 0}
        )

    for r in frappe.db.sql(
        "select greenhouse, unit_type, count(*) c from `tabBed` "
        "where greenhouse in %(s)s group by greenhouse, unit_type",
        {"s": stations},
        as_dict=True,
    ):
        slot(r.greenhouse, r.unit_type)["units"] = r.c

    for r in frappe.db.sql(
        "select b.greenhouse g, count(*) c from `tabZone` z join `tabBed` b on b.name = z.bed "
        "where b.greenhouse in %(s)s and b.unit_type = 'Bed' group by b.greenhouse",
        {"s": stations},
        as_dict=True,
    ):
        slot(r.g, "Bed")["children"] = r.c

    for r in frappe.db.sql(
        "select b.greenhouse g, count(*) c from `tabOrchard Tree` t join `tabBed` b on b.name = t.row "
        "where b.greenhouse in %(s)s and b.unit_type = 'Row' group by b.greenhouse",
        {"s": stations},
        as_dict=True,
    ):
        slot(r.g, "Row")["children"] = r.c

    # Per hexa, so a hexa with 0 < n < 6 triads is counted as an edge hexa.
    for r in frappe.db.sql(
        "select b.greenhouse g, b.name, count(t.name) c from `tabBed` b "
        "left join `tabTriad` t on t.row = b.name "
        "where b.greenhouse in %(s)s and b.unit_type = 'Hexa' group by b.greenhouse, b.name",
        {"s": stations},
        as_dict=True,
    ):
        s = slot(r.g, "Hexa")
        s["children"] += r.c
        if r.c < TRIADS_PER_HEXA:
            s["edge"] += 1
    return out


def _build(farm):
    built_at = str(now_datetime())
    from upande_scp.serverscripts.geo.triad_size import standard_side_m

    side = standard_side_m()
    empty = {"farm": farm, "root": None, "paths": [], "built_at": built_at, "triad_side_m": side}

    rows = frappe.get_all(
        "Warehouse",
        filters={"custom_farm": farm},
        fields=["name", "warehouse_name", "parent_warehouse", "warehouse_type"],
    )
    by_name = {r.name: r for r in rows}
    root_row = next((r for r in rows if r.warehouse_type == "Farm"), None)
    if not root_row:
        return empty

    kids = {}
    for r in rows:
        if r.parent_warehouse in by_name and r.name != root_row.name:
            kids.setdefault(r.parent_warehouse, []).append(r)

    counts = _unit_counts([r.name for r in rows])
    paths = {}

    def make(row, chain):
        type_ = row.warehouse_type or NO_TYPE
        chain = chain + [type_]
        node = {
            "name": row.name,
            "label": row.warehouse_name or row.name,
            "type": type_,
            "children": [],
            "unit": None,
            "flags": [],
        }
        if not row.warehouse_type:
            node["flags"].append("no type")

        held = counts.get(row.name) or {}
        if held:
            kind = max(held, key=lambda k: held[k]["units"])
            node["unit"] = {"kind": kind or UNKNOWN, **held[kind]}
            if len(held) > 1:
                node["flags"].append("mixed kinds")
            if any(k not in PAIR for k in held):
                node["flags"].append("unknown kind")
            for k, v in held.items():
                p = paths.setdefault(tuple(chain + [k or UNKNOWN, PAIR.get(k, "?")]), set())
                p.add(row.name)
        elif type_ in STATION_TYPES:
            node["flags"].append("no layout")

        for child in sorted(kids.get(row.name, []), key=lambda r: r.warehouse_name or r.name):
            node["children"].append(make(child, chain))
        return node

    root = make(root_row, [])
    return {
        "farm": farm,
        "root": root,
        "paths": [
            {"types": list(t), "stations": len(s)}
            for t, s in sorted(paths.items(), key=lambda kv: kv[0])
        ],
        "built_at": built_at,
        "triad_side_m": side,
    }
