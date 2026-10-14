# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

from upande_scp.serverscripts.common.warehouse_classify import (
    is_chemical_store,
    is_fertilizer_store,
)

from upande_scp.serverscripts.scouting import capture_settings


class ScoutingandCropProtectionSettings(Document):
    def validate(self):
        chem = {r.item_group for r in (self.chemical_item_groups or []) if r.item_group}
        fol = {r.item_group for r in (self.foliar_item_groups or []) if r.item_group}
        overlap = chem & fol
        if overlap:
            frappe.throw(
                "An Item Group cannot be both a Chemical and a Foliar group: "
                + ", ".join(sorted(overlap))
            )

        # Scout capture (pieces 5–6). A loaded Single reads a missing Check as 0
        # and saves a None Int as 0; never let that switch capture off or zero
        # the cap. An Int cannot tell 0 from unset, so 0 means the default.
        capture_settings.fill_unset(self)
        if not self.max_count_per_observation:
            self.max_count_per_observation = capture_settings.DEFAULT_MAX_COUNT
        self.max_count_per_observation = capture_settings.clean_max_count(
            self.max_count_per_observation
        )


def get_allowed_farms():
    """Return the list of farm names enabled in Scouting and Crop Protection Settings."""
    farms = frappe.get_all(
        "Spray Plan Allowed Farm",
        filters={"parenttype": "Scouting and Crop Protection Settings"},
        pluck="farm",
    )
    return [f for f in farms if f]


def _allowed_warehouses_matching(predicate):
    """Non-disabled Warehouse names whose name satisfies ``predicate`` and that
    are in scope for the allowed farms. Empty when no farms are configured.

    A warehouse is in scope when its ``custom_farm`` is one of the allowed
    farms, OR it has no ``custom_farm`` set (NULL/blank → treated as global).
    The operational stores and CSUs on single-farm sites (e.g. mona's
    "Chemical Main Store - MFK" / "Main CSU A - MFK") are untagged, so a
    strict ``custom_farm IN farms`` filter hid them and starved the chemical-
    source picker. This mirrors the "NULL farm = global" convention the
    spray-team query already uses; a store tagged to a *different* farm stays
    hidden."""
    farms = get_allowed_farms()
    if not farms:
        return []
    farms_set = set(farms)
    rows = frappe.get_all(
        "Warehouse",
        filters={"disabled": 0},
        fields=["name", "custom_farm"],
        order_by="name asc",
    )
    out = []
    for r in rows:
        name = r.get("name")
        if not predicate(name):
            continue
        farm = r.get("custom_farm")
        # NULL/blank farm = global; otherwise it must be one of the user's farms.
        if farm and farm not in farms_set:
            continue
        out.append(name)
    return out


def _configured_stores(fieldname):
    """Non-disabled warehouses explicitly listed in the given Scouting and Crop Protection Settings
    child table (``chemical_stores`` / ``fertigation_stores``). The admin's
    explicit choice wins as-is — no farm scoping — so a deliberately picked
    global store (e.g. an untagged main store) is always honoured. Returns [] when
    nothing is configured, so callers can fall back to the name heuristic."""
    rows = frappe.get_all(
        "Spray Plan Store Warehouse",
        filters={"parenttype": "Scouting and Crop Protection Settings", "parentfield": fieldname},
        pluck="warehouse",
    )
    names = [w for w in rows if w]
    if not names:
        return []
    live = set(
        frappe.get_all(
            "Warehouse",
            filters={"name": ["in", names], "disabled": 0},
            pluck="name",
        )
    )
    # Preserve the configured order, drop any disabled/deleted ones.
    return [w for w in names if w in live]


def get_allowed_chemical_store_warehouses():
    """Chemical-store warehouses. Prefers the explicit Scouting and Crop Protection Settings list;
    falls back to the ``chemical … store`` name heuristic when unset."""
    return _configured_stores("chemical_stores") or _allowed_warehouses_matching(
        is_chemical_store
    )


def get_allowed_fertilizer_unit_warehouses():
    """Fertigation / foliar warehouses. Prefers the explicit Scouting and Crop Protection Settings
    list; falls back to the ``fertilizer … store`` name heuristic when unset."""
    return _configured_stores("fertigation_stores") or _allowed_warehouses_matching(
        is_fertilizer_store
    )
