"""after_migrate enforcer: group upande_scp's crop-protection/scouting custom
fields into one 'Scouting and Crop Protection' tab per shared doctype.

Layout only (custom-field insert_after). Idempotent. Classification is fixed
(cross-app code reference; see the design spec) — do NOT infer from names.
"""
import frappe

from ..store.spray_stock_types import SE_TYPE_TRANSFER

TAB = "custom_scouting_and_crop_protection_tab"
TAB_LABEL = "Scouting and Crop Protection"

# Declared locally, as every other module does (spray_session, lifecycle,
# auto_material_issue, ...) — layout code must not import the resolver.
AFP_TYPE = "Application Floor Plan"
from ..common.tank_mix import tank_mix_item_group

# Ordered SCP fields per doctype (display order under the tab).
SCP_FIELDS = {
    "Item": [
        # Chemical metadata moved to the Chemical/Foliar doctypes; only the
        # per-variety intervention thresholds remain on the Item.
        "custom_chemical_intervention_threshhold",
    ],
    "Work Order": [
        "custom_type", "custom_classification", "custom_preventive_reason",
        "custom_application_floor_plan", "custom_greenhouse", "custom_reentry_period_hrs",
        "custom_cost_center", "custom_rate_overridden", "custom_weather_snapshot",
        "custom_scheduled_application_time", "custom_reentry_time", "custom_scope",
        "custom_scope_details", "custom_area", "custom_water_volume", "custom_water_ph",
        "custom_water_hardness", "custom_variety", "custom_spray_type", "custom_kit",
        "custom_targets", "custom_spray_team", "custom_spray_plan_team_members",
        "custom_chemical_scans", "custom_spray_application_logsheet",
    ],
    "Warehouse": [
        "custom_location", "custom_raw_geojson", "custom_cost_center",
        "custom_bed_numbering", "custom_zone_numbering", "custom_area_ha",
    ],
    "BOM": [
        "custom_item_group", "custom_water_ph", "custom_water_hardness",
        "custom_work_order",
    ],
    "Farm": [
        "custom_chemical_store", "custom_fertilizer_store", "spray_plan_creators",
        "spray_plan_approvers", "spray_supervisors", "store_keepers",
    ],
    # Stock Entry carries exactly one SCP layout concern: the store-label print
    # audit trail, written by `spray_plan_labels._stamp_labels_printed` and read
    # back by `lifecycle` / `store_keeper_api`. The fields themselves are
    # declared by `store.stock_entry_fields`; this list only orders them.
    # `custom_farm` is deliberately absent — it is a document-level field that
    # belongs next to posting_time, not inside a crop-protection tab.
    "Stock Entry": [
        "custom_labels_printed", "custom_labels_printed_by",
        "custom_labels_printed_on", "custom_labels_print_count",
    ],
}

# Optional per-doctype `depends_on` for the tab itself. Stock Entry is shared
# with harvest, milking and biometric flows, so an always-on SCP tab would show
# an irrelevant, permanently-empty tab on every receipt and issue. Labels are
# only ever printed for the chemical transfer out of the store
# (`spray_stock_types.SE_TYPE_TRANSFER`), so the tab appears for that type — plus
# any entry already stamped as printed, so historical audit trails stay visible
# even if an entry's type is later renamed.
# Doctypes that get deterministic placement instead of the default
# trailing-tab strategy: the tab is slotted immediately BEFORE a named standard
# Tab Break, and no foreign field's insert_after is ever rewritten.
#
# The default strategy anchors the tab after the tail of every foreign "stray"
# chain, which assumes Frappe's resolved field order agrees with the
# insert_after graph. That assumption fails on a heavily-customised shared
# doctype: Frappe resolves custom fields in a single insert_after pass, so a
# field whose anchor hasn't been placed yet is laid down early. When Stock Entry
# still carried 70 custom fields from four apps, the harvest chain rooted at
# `custom_output_quantity` (itself resolved dead last) had its tail resolved
# mid-form, so "after the stray tail" put our tab in the middle of the details
# tab, swallowing the Items table. It never converged on re-run, because the
# graph the enforcer reads and the order the form renders were two different
# things.
#
# Stock Entry is clean now, so both strategies would work — but it is shared by
# four apps and will accumulate fields again, so the deterministic placement
# stays. It also reads better: Connections belongs last by Frappe convention,
# which the default strategy would violate by anchoring past it.
TAB_BEFORE = {"Stock Entry": "tab_connections"}

TAB_DEPENDS_ON = {
    "Stock Entry": (
        f'eval:doc.stock_entry_type=="{SE_TYPE_TRANSFER}"'
        ' || doc.custom_labels_printed'
    ),
    # Work Order and BOM are shared with manufacturing: only spray plans and
    # the tank-mix BOMs they generate carry SCP data, so the tab stays hidden
    # on every other Work Order / BOM rather than showing an empty tab. Both
    # discriminators are the ones SCP itself writes and reads —
    # `custom_type` (drafts/approval) and `custom_item_group` == Chemical Mix
    # (stamped by bom_resolver.create_bom_for_plan + store.create_bom, read back
    # by bom_resolver.cancel_orphan_plan_bom).
    "Work Order": f'eval:doc.custom_type=="{AFP_TYPE}"',
    "BOM": f'eval:doc.custom_item_group=="{tank_mix_item_group()}"',
}


def enforce(doc=None, method=None):
    """after_migrate entry-point. One doctype failing never aborts the rest."""
    for dt, fields in SCP_FIELDS.items():
        try:
            _enforce_doctype(dt, fields)
        except Exception:
            frappe.log_error(
                title=f"scouting_tab_layout: {dt}",
                message=frappe.get_traceback(),
            )


def _names(dt):
    return {c["fieldname"]: c["name"] for c in frappe.get_all(
        "Custom Field", filters={"dt": dt}, fields=["name", "fieldname"])}


def _order(dt):
    return [df.fieldname for df in frappe.get_meta(dt, cached=False).fields]


def _children_map(dt):
    """Ground-truth (DB) parent -> [child fieldname, ...], built straight from
    insert_after, independent of Frappe's (possibly corrupted) resolved
    field order. Used only to walk an already-foreign field's own chain to
    its tail, never to decide membership."""
    m = {}
    for c in frappe.get_all("Custom Field", filters={"dt": dt},
                             fields=["fieldname", "insert_after"]):
        m.setdefault(c.insert_after, []).append(c.fieldname)
    return m


def _chain_tail(root, children, scp):
    """Walk a single-file (non-forking, non-SCP) chain from `root` to its
    terminal leaf. Stops at the first fork, cycle, or SCP field so we never
    misattribute someone else's branch."""
    node, seen = root, {root}
    while True:
        kids = [k for k in children.get(node, []) if k not in scp]
        if len(kids) != 1 or kids[0] in seen:
            return node
        node = kids[0]
        seen.add(node)


def _set_field(name, prop, value):
    """Set one property on one Custom Field only if it changed. Returns 1/0.

    ignore_validate skips Custom Field's on_update -> validate_fields_for_doctype,
    which revalidates *every* field on the doctype (standard fields included)
    on every save. Same flag Frappe's own create_custom_field(s) uses for bulk/
    system field writes. Without it, an unrelated pre-existing standard-field
    defect elsewhere on the doctype (e.g. Farm.farm_type: Table MultiSelect
    with in_list_view=1, invalid regardless of us) would abort a pure
    insert_after change here. We only ever touch insert_after; nothing this
    flag skips is something we rely on.
    """
    if (frappe.db.get_value("Custom Field", name, prop) or "") == (value or ""):
        return 0
    cf = frappe.get_doc("Custom Field", name)
    cf.set(prop, value)
    cf.flags.ignore_validate = True
    cf.save(ignore_permissions=True)
    return 1


def _set_after(name, new_ia):
    """Set insert_after on one Custom Field only if it changed. Returns 1/0."""
    return _set_field(name, "insert_after", new_ia)


def _intrinsic_roots(dt, scp, names, order_set):
    """Foreign fields whose OWN insert_after is invalid for us on its face:
    chained onto an SCP field / the tab (would get dragged inside our
    block), or dangling (points at a fieldname that doesn't exist on this
    doctype at all — a leftover from an earlier, since-renamed layout).
    Corruption-independent: doesn't reference `anchor`, so a root here can
    never end up nominating itself as the anchor."""
    roots = set()
    for fn, name in names.items():
        if fn in scp:
            continue
        ia = frappe.db.get_value("Custom Field", name, "insert_after")
        if ia in scp or (ia and ia not in order_set):
            roots.add(fn)
    return roots


def _reachable(roots, children, scp):
    """Every non-SCP field reachable from any of `roots` via ground-truth
    child edges (roots included). A whole stray subtree, not just its root
    — none of these may ever be picked as an anchor/safe-target, since
    they're already slated to move as a unit."""
    seen = set(roots)
    stack = list(roots)
    while stack:
        node = stack.pop()
        for k in children.get(node, []):
            if k in scp or k in seen:
                continue
            seen.add(k)
            stack.append(k)
    return seen


def _pick(order, avoid):
    """Last field in `order` that isn't in `avoid` (which already includes
    all SCP fields plus every stray subtree currently known)."""
    for fn in reversed(order):
        if fn not in avoid:
            return fn
    return order[-1] if order else None


def _ensure_tab(dt, names, anchor):
    """Create the tab break anchored at `anchor` if it's missing. Returns the
    (possibly refreshed) fieldname -> Custom Field name map."""
    if TAB in names:
        return names
    cf = frappe.new_doc("Custom Field")
    cf.dt = dt
    cf.fieldname = TAB
    cf.label = TAB_LABEL
    cf.fieldtype = "Tab Break"
    cf.insert_after = anchor
    cf.print_hide = 1
    cf.depends_on = TAB_DEPENDS_ON.get(dt) or ""
    cf.insert(ignore_permissions=True)
    return _names(dt)


def _enforce_before_tab(dt, scp_fields, before_tab):
    """Place the tab immediately before the standard Tab Break `before_tab`, and
    chain the SCP fields under it. Touches only our own Custom Fields."""
    scp = set(scp_fields) | {TAB}
    names = _names(dt)
    # Resolved order with our own fields removed, so the anchor we pick is a
    # position in the form as actually rendered, not in the insert_after graph.
    order = [fn for fn in _order(dt) if fn not in scp]
    if before_tab not in order:
        raise ValueError(f"{dt}: anchor tab break {before_tab!r} not on doctype")

    # Walk back from `before_tab` to the nearest field that no other custom
    # field is already anchored on. Sharing an anchor forks Frappe's order
    # resolution and could interleave that field's branch into our tab.
    taken = {
        c["insert_after"] for c in frappe.get_all(
            "Custom Field", filters={"dt": dt}, fields=["insert_after", "fieldname"])
        if c["fieldname"] not in scp and c["insert_after"]
    }
    idx = order.index(before_tab)
    anchor = None
    for fn in reversed(order[:idx]):
        if fn not in taken:
            anchor = fn
            break
    if anchor is None:
        raise ValueError(f"{dt}: no free anchor before {before_tab!r}")

    names = _ensure_tab(dt, names, anchor)

    changed = _set_after(names[TAB], anchor)
    changed += _set_field(names[TAB], "depends_on", TAB_DEPENDS_ON.get(dt) or "")
    prev = TAB
    for fn in scp_fields:
        if fn in names:
            changed += _set_after(names[fn], prev)
            prev = fn

    if changed:
        frappe.clear_cache(doctype=dt)
    return changed


def _enforce_doctype(dt, scp_fields):
    before_tab = TAB_BEFORE.get(dt)
    if before_tab:
        return _enforce_before_tab(dt, scp_fields, before_tab)

    scp = set(scp_fields) | {TAB}
    order = _order(dt)
    names = _names(dt)
    children = _children_map(dt)

    roots = _intrinsic_roots(dt, scp, names, set(order))
    excluded = scp | _reachable(roots, children, scp)
    anchor = _pick(order, excluded)

    # 1. ensure the tab break exists, anchored at `anchor`
    if TAB not in names:
        names = _ensure_tab(dt, names, anchor)
        order = _order(dt)
        children = _children_map(dt)
        roots = _intrinsic_roots(dt, scp, names, set(order))
        excluded = scp | _reachable(roots, children, scp)
        anchor = _pick(order, excluded)

    changed = 0

    # 2. also catch foreign fields merely COMPETING with the tab for the
    #    same anchor slot (a valid, existing, non-SCP field — just one the
    #    tab itself is about to claim). Left alone, two fields sharing one
    #    insert_after forks Frappe's field-order resolution and can
    #    interleave the fork's two branches unpredictably.
    competing = {
        fn for fn, name in names.items()
        if fn not in excluded
        and frappe.db.get_value("Custom Field", name, "insert_after") == anchor
    }
    stray_roots = sorted(roots | competing)

    # 3. re-chain each stray's whole (foreign) subtree serially in front of
    #    the tab (right after `anchor`), so no two fields ever end up
    #    sharing an insert_after with the tab or with each other. Only the
    #    root of each subtree is repointed — its existing descendants keep
    #    their own (already-valid, internal) insert_after chain and simply
    #    follow along.
    prev = anchor
    for root in stray_roots:
        changed += _set_after(names[root], prev)
        prev = _chain_tail(root, children, scp)

    # 4. anchor the tab as a trailing tab (after `anchor` + any re-chained strays)
    changed += _set_after(names[TAB], prev)

    #    ...and keep its visibility condition in sync (no-op where unset, so an
    #    always-on tab stays always-on).
    changed += _set_field(names[TAB], "depends_on", TAB_DEPENDS_ON.get(dt) or "")

    # 5. chain SCP fields under the tab (only those present on the site)
    prev = TAB
    for fn in scp_fields:
        if fn in names:
            changed += _set_after(names[fn], prev)
            prev = fn

    if changed:
        frappe.clear_cache(doctype=dt)
    return changed
