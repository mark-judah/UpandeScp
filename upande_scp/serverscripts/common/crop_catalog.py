"""What belongs to a crop: its pests, diseases, farms and greenhouses.

The crop is fixed by the route (`#/rose/…`). Every crop-scoped list on the server
reads it from here, from the same rows the mobile app's `getObservationsDetails`
reads (`Pest Filter` / `Disease Filter` by `crop_scouted`), so web and phone agree.

**One site-wide Redis entry, built with raw SQL.** `Crop Scouted` carries a
permission query condition; an index built through `frappe.get_all` would store
the first caller's crops and serve them to everyone.

**Crop names are matched case-insensitively.** Routes carry `rose`, the doctype is
`Rose`. MariaDB would compare them equal; a Python set would not. Everything
below goes through `canonical()` first.

**A greenhouse belongs to exactly one crop** — the first crop (by `Farm Filter.idx`)
that lists its farm, the rule `spray_compliance.context.crop_for_greenhouse` always
used. That is what keeps D5 ("a crop-less entry counts under its greenhouse's
crop") from counting one entry under two crops.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common.cache_utils import (
    K_CROP_CATALOG,
    TTL_MEDIUM,
    get_or_set,
    invalidate,
)

#: Pads an empty `IN (...)` list. MariaDB rejects `IN ()`, and dropping the clause
#: instead would widen the result to every crop — the opposite of an empty list.
NO_MATCH = "__scp_no_match__"

_OBS_PARAM = {"pest": "crop_pests", "disease": "crop_diseases"}


def build_index(crop_names, pest_rows, disease_rows, farm_rows, house_rows) -> dict:
    """Fold the raw rows into the lookup index. Pure.

    ``farm_rows`` must arrive ordered by (idx, parent): the first crop to list a
    farm owns it.
    """
    pests: dict[str, set] = {}
    for r in pest_rows:
        if r.get("crop_scouted") and r.get("pest"):
            pests.setdefault(r["crop_scouted"], set()).add(r["pest"])

    diseases: dict[str, set] = {}
    for r in disease_rows:
        if r.get("crop_scouted") and r.get("disease"):
            diseases.setdefault(r["crop_scouted"], set()).add(r["disease"])

    farms: dict[str, set] = {}
    farm_crop: dict[str, str] = {}
    for r in farm_rows:
        crop, farm = r.get("parent"), r.get("farm")
        if not crop or not farm:
            continue
        farms.setdefault(crop, set()).add(farm)
        farm_crop.setdefault(farm, crop)

    houses: dict[str, set] = {}
    for r in house_rows:
        owner = farm_crop.get(r.get("custom_farm") or "")
        if owner and r.get("name"):
            houses.setdefault(owner, set()).add(r["name"])

    def _lists(d: dict) -> dict:
        return {k: sorted(v) for k, v in d.items()}

    return {
        "crops": sorted(c for c in crop_names if c),
        "pests": _lists(pests),
        "diseases": _lists(diseases),
        "farms": _lists(farms),
        "farm_crop": farm_crop,
        "farms_crops": {f: sorted(c for c, fs in farms.items() if f in fs) for f in farm_crop},
        "houses": _lists(houses),
    }


def _load() -> dict:
    sql = frappe.db.sql
    return build_index(
        [r[0] for r in sql("select name from `tabCrop Scouted`")],
        sql(
            """select crop_scouted, pest from `tabPest Filter`
               where ifnull(crop_scouted, '') != '' and ifnull(pest, '') != ''""",
            as_dict=True,
        ),
        sql(
            """select crop_scouted, disease from `tabDisease Filter`
               where ifnull(crop_scouted, '') != '' and ifnull(disease, '') != ''""",
            as_dict=True,
        ),
        sql(
            """select parent, farm from `tabFarm Filter`
               where parenttype = 'Crop Scouted' and parentfield = 'farms'
               order by idx, parent""",
            as_dict=True,
        ),
        sql(
            """select name, custom_farm from `tabWarehouse`
               where is_group = 0 and ifnull(custom_farm, '') != ''""",
            as_dict=True,
        ),
    )


def catalog() -> dict:
    return get_or_set(K_CROP_CATALOG, _load, ttl=TTL_MEDIUM) or {}


def invalidate_catalog() -> None:
    invalidate(K_CROP_CATALOG)


def canonical(crop) -> str:
    """`rose` → `Rose`. `""` for a blank or unknown crop."""
    name = (crop or "").strip()
    if not name:
        return ""
    low = name.lower()
    for c in catalog().get("crops", []):
        if c.lower() == low:
            return c
    return ""


def resolve_crop(crop, user: str | None = None) -> str:
    """The canonical crop for a request, refused when unknown or not allowed.

    Blank stays blank — that is the back-compat "no crop" path.
    """
    name = (crop or "").strip()
    if not name:
        return ""
    canon = canonical(name)
    if not canon:
        frappe.throw(f"Unknown crop: {name}.", frappe.PermissionError)
    crop_scope.assert_crop(canon, user)
    return canon


def pests_for_crop(crop) -> list[str]:
    return list(catalog().get("pests", {}).get(canonical(crop), []))


def diseases_for_crop(crop) -> list[str]:
    return list(catalog().get("diseases", {}).get(canonical(crop), []))


def targets_for_crop(crop) -> list[str]:
    return sorted(set(pests_for_crop(crop)) | set(diseases_for_crop(crop)))


def greenhouses_for_crop(crop) -> list[str]:
    return list(catalog().get("houses", {}).get(canonical(crop), []))


def crop_for_farm(farm) -> str | None:
    if not farm:
        return None
    return catalog().get("farm_crop", {}).get(farm) or None


def crop_for_greenhouse(wh) -> str | None:
    """Crop of a greenhouse or block warehouse (any warehouse with a custom_farm): a block
    growing something answers with that crop, anything else with its farm's crop."""
    if not wh:
        return None
    farm, kind = frappe.db.get_value("Warehouse", wh, ["custom_farm", "warehouse_type"]) or (None, None)
    if kind == "Block":
        # A farm can grow several crops (Mutara: avocado blocks and vegetable pivots), so a
        # block's crop is what is planted there, not the farm's one crop. Unplanted blocks
        # fall back to the farm's crop as before.
        from upande_scp.serverscripts.common import planting

        planted = planting.crop_for_station(wh)
        if planted:
            return planted
        return block_fallback_crop(farm)
    return crop_for_farm(farm)


def block_fallback_crop(farm) -> str | None:
    """Crop of a block with nothing planted (no live cycle, no crop on it or above it).

    A single-crop farm's blocks are that crop. On a farm several crops share (Mutara:
    avocado phases and vegetable pivots) an empty block is no crop at all: a fallow
    pivot block must not show up under avocado just because avocado is listed first."""
    if not farm:
        return None
    if len(catalog().get("farms_crops", {}).get(farm, [])) > 1:
        return None
    return crop_for_farm(farm)


def bed_crops() -> list[str]:
    """Crops whose farms hold Greenhouse-type warehouses (greenhouse -> bed layout).

    Every other crop is planned block by block (Application Floor Plan on a block
    map), including a new crop that has no places yet. Decided from the warehouse
    type, not from the crop's name. Greenhouses take their farm's crop (only Block
    warehouses are resolved through planting), so this is the farm_crop of every
    farm that has a Greenhouse."""
    farm_crop = catalog().get("farm_crop", {})
    if not farm_crop:
        return []
    farms = frappe.db.sql_list(
        """select distinct custom_farm from `tabWarehouse`
           where is_group = 0 and warehouse_type = 'Greenhouse'
             and ifnull(custom_farm, '') != ''"""
    )
    return sorted({farm_crop[f] for f in farms if f in farm_crop})


def crops_for_greenhouses(whs) -> dict:
    """``{warehouse: crop or None}`` by the `crop_for_greenhouse` rule, in a fixed
    number of queries however many warehouses (an approval list can hold hundreds)."""
    whs = [w for w in dict.fromkeys(whs or []) if w]
    if not whs:
        return {}
    rows = {
        r.name: r
        for r in frappe.get_all(
            "Warehouse",
            filters={"name": ["in", whs]},
            fields=["name", "custom_farm", "warehouse_type"],
            limit_page_length=0,
        )
    }
    blocks = [w for w in whs if (rows.get(w) or {}).get("warehouse_type") == "Block"]
    planted: dict = {}
    if blocks:
        from upande_scp.serverscripts.common import planting

        planted = planting.crops_for_stations(blocks)
    def _crop(w):
        row = rows.get(w) or {}
        if row.get("warehouse_type") == "Block":
            return planted.get(w) or block_fallback_crop(row.get("custom_farm"))
        return crop_for_farm(row.get("custom_farm"))

    return {w: _crop(w) for w in whs}


def keep_crop(rows, crop, field: str = "custom_greenhouse") -> list:
    """The rows whose warehouse (``row[field]``) grows ``crop``. A blank crop keeps
    everything — the back-compat "no crop section" call. Work Orders carry no crop,
    so a plan belongs to the crop of the place it is for."""
    rows = list(rows or [])
    canon = canonical(crop)
    if not (crop or "").strip():
        return rows
    if not canon:
        return []
    crops = crops_for_greenhouses(r.get(field) for r in rows)
    return [r for r in rows if crops.get(r.get(field)) == canon]


def entry_crop_condition(alias: str = "se") -> str:
    """D5: the crop's entries plus crop-less entries in the crop's greenhouses/blocks.

    The station is `COALESCE(NULLIF(greenhouse,''), block)`: avocado entries have a
    blank greenhouse and a set block. `crop_whs` holds both Greenhouse- and
    Block-type warehouses of the crop's farms.

    Params: `crop`, `crop_whs` — see `crop_sql_params`.
    """
    return (
        f"({alias}.crop_scouted = %(crop)s OR (IFNULL({alias}.crop_scouted, '') = '' "
        f"AND COALESCE(NULLIF({alias}.greenhouse, ''), {alias}.block) IN %(crop_whs)s))"
    )


def obs_crop_condition(kind: str, column: str) -> str:
    """D4: a pest/disease child row counts only when it is linked to the crop."""
    return f"{column} IN %({_OBS_PARAM[kind]})s"


def crop_sql_params(crop) -> dict:
    """Params for both conditions. Every list is padded with `NO_MATCH`, and an
    unknown crop becomes `NO_MATCH` too, so nothing ever widens to all crops."""
    canon = canonical(crop)
    return {
        "crop": canon or NO_MATCH,
        "crop_whs": tuple(greenhouses_for_crop(canon)) or (NO_MATCH,),
        "crop_pests": tuple(pests_for_crop(canon)) or (NO_MATCH,),
        "crop_diseases": tuple(diseases_for_crop(canon)) or (NO_MATCH,),
    }
