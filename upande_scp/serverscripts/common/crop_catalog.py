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

#: Crops this site works with. The catalog is read from `Crop Scouted`, so a site
#: that holds other crop rows would otherwise offer them. Mona Flowers grows roses
#: only: anything else is invisible to every crop-scoped list, picker and route.
#: `None` would mean "whatever the site has" (kaitet's behaviour).
ENABLED_CROPS: tuple[str, ...] | None = ("Rose",)

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
        "houses": _lists(houses),
    }


def _load() -> dict:
    sql = frappe.db.sql
    return build_index(
        [
            r[0]
            for r in sql("select name from `tabCrop Scouted`")
            if ENABLED_CROPS is None or r[0] in ENABLED_CROPS
        ],
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
    # The access gate (user -> Employee -> Company -> Farm -> crop) exists to keep one
    # company's crops from another's. On a single-crop site there is nothing to keep
    # apart, and the gate would lock out every user whose Employee/Farm company data is
    # not set up - so it is only enforced when the site is not pinned to ENABLED_CROPS.
    if ENABLED_CROPS is None:
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
    """Crop of a greenhouse or block warehouse (any warehouse with a custom_farm)."""
    if not wh:
        return None
    farm = frappe.db.get_value("Warehouse", wh, "custom_farm")
    return crop_for_farm(farm)


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
