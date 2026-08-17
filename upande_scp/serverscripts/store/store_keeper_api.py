"""Store-Keeper API — backs the two React pages in ``/scp_app``:

  * ``Chemical Dashboard``      → ``chemical_stock_overview``
  * ``Spray Plan Transfers``    → ``list_draft_transfers``,
                                  ``submit_with_biometric``

Permissions: every endpoint requires the ``Store Keeper`` role (System
Manager / Administrator still allowed for support / debugging). The
React sidebar gates the pages, but we re-check here so a curl call
from another session can't sneak past.

Biometric model mirrors the existing Material-Issue flow the team
already trusts, but scp owns its own copy so it does not depend on the
site-stored Desk Server Script: ``verify_employee`` reads the most
recent ``Biometric Logs`` row from the last couple of minutes and
returns ``{employee, employee_name, biometric_id}``. The frontend
calls that once (UX prompt), then calls ``submit_with_biometric`` with
the list of Stock Entry names to authorise. We re-validate the scan
freshness server-side and write the result into each SE's
``biometric_data`` child table before submitting.
"""

import json
import os
from datetime import timedelta

import frappe
from frappe.utils import now_datetime, add_to_date

from upande_scp.serverscripts.common.crop_protection import product_groups


# ----------------------------------------------------------------------
# Permission gate
# ----------------------------------------------------------------------
_WRITE_ROLES = {"SCP Chemical Store Keeper", "System Manager", "Administrator", "SCP General Manager"}


def _check_perm():
    roles = set(frappe.get_roles(frappe.session.user) or [])
    if not (roles & _WRITE_ROLES):
        frappe.throw(
            "You need the SCP Chemical Store Keeper role to access this endpoint.",
            frappe.PermissionError,
        )


# ----------------------------------------------------------------------
# Farm scoping — a plain Store Keeper only sees stock for the farm(s)
# they're assigned to (Farm.store_keepers child table); System Manager /
# Administrator / General Manager see everything, unchanged.
# ----------------------------------------------------------------------
def _is_elevated(user=None):
    roles = set(frappe.get_roles(user or frappe.session.user))
    return bool(roles & {"System Manager", "Administrator", "SCP General Manager"})


def _allowed_farms_for(user=None):
    """``None`` => user sees all stores (admin/GM). Else the list of farms
    where the user is an assigned store keeper (possibly empty)."""
    user = user or frappe.session.user
    if _is_elevated(user):
        return None
    return frappe.get_all(
        "Farm Store Keeper",
        filters={"user": user, "parenttype": "Farm"},
        pluck="parent",
    )


def allowed_stores_for(user=None):
    """``None`` => every store. Else the specific warehouses this user keeps.

    A keeper row now names the store it applies to (``Farm Store Keeper.warehouse``),
    so a farm with separate chemical and fertilizer keepers scopes correctly.

    Rows with no warehouse — unmigrated, or added by hand — **fall back to their
    farm's mapped chemical/fertilizer stores**, so a half-migrated site degrades
    to the previous farm-level behaviour rather than showing an empty dashboard.

    General-store keepers live on the settings Single (they belong to no farm),
    and their stores are unioned in here.
    """
    user = user or frappe.session.user
    if _is_elevated(user):
        return None

    stores: set = set()

    for row in frappe.get_all(
        "Farm Store Keeper",
        filters={"user": user, "parenttype": "Farm"},
        fields=["parent", "warehouse"],
    ):
        if row.warehouse:
            stores.add(row.warehouse)
            continue
        mapped = frappe.db.get_value(
            "Farm", row.parent,
            ["custom_chemical_store", "custom_fertilizer_store"], as_dict=True,
        ) or {}
        for wh in (mapped.get("custom_chemical_store"), mapped.get("custom_fertilizer_store")):
            if wh:
                stores.add(wh)

    for row in frappe.get_all(
        "Farm Store Keeper",
        filters={"user": user, "parentfield": "general_store_keepers"},
        fields=["warehouse"],
    ):
        if row.warehouse:
            stores.add(row.warehouse)

    return sorted(stores)


def bucket_overview(matrix, chem_group_items, chem_stores, fert_stores):
    """Split overview rows into chemical vs fertilizer buckets with per-store,
    per-item and grand totals. ``chem_group_items`` = set of item_codes in the
    configured chemical item groups; everything else falls into the fertilizer
    bucket.
    Each bucket is ALSO restricted to its mapped-store warehouse set
    (``chem_stores``/``fert_stores`` — a farm's ``custom_chemical_store`` /
    ``custom_fertilizer_store``) so CSUs, WIP and general stores never show
    up in the dashboard's totals, regardless of caller role.
    Pure — no DB access, so it's covered by a plain unit test."""
    def _bucket(is_chem, allowed_stores):
        pick = [m for m in matrix
                if (m["item_code"] in chem_group_items) == is_chem
                and m["warehouse"] in allowed_stores]
        by_item, by_wh = {}, {}
        for m in pick:
            by_item[m["item_code"]] = by_item.get(m["item_code"], 0.0) + float(m["qty"] or 0)
            w = by_wh.setdefault(m["warehouse"], {"warehouse": m["warehouse"], "total_qty": 0.0, "item_count": 0})
            w["total_qty"] += float(m["qty"] or 0)
            w["item_count"] += 1
        return {
            "stores": sorted(by_wh.values(), key=lambda x: -x["total_qty"]),
            "items": sorted(({"item_code": k, "total_qty": v} for k, v in by_item.items()), key=lambda x: -x["total_qty"]),
            "matrix": pick,
            "total_qty": sum(by_item.values()),
        }
    return {"chemical": _bucket(True, chem_stores), "fertilizer": _bucket(False, fert_stores)}


# ----------------------------------------------------------------------
# Chemical Dashboard
# ----------------------------------------------------------------------
def _chemical_group_items():
    """Item codes under the configured CHEMICAL groups — the set
    ``bucket_overview`` uses to split chemical rows from fertilizer rows."""
    groups = product_groups("chemical")
    if not groups:
        return set()
    return set(
        frappe.get_all("Item", filters={"item_group": ("in", list(groups))}, pluck="name")
    )


@frappe.whitelist()
def chemical_stock_overview() -> dict:
    """In-stock chemicals across every warehouse.

    Returns:
      {
        "items":      [{item_code, item_name, uom, total_qty, group}],
        "warehouses": [{warehouse, total_qty, item_count}],
        "matrix":     [{item_code, warehouse, qty}],
        "as_of":      ISO timestamp,
      }

    Only positive ``actual_qty`` rows are kept — out-of-stock /
    negative-qty bins clutter the table and the user explicitly asked
    for "only show chemicals in stock".

    Scoped to the caller's assigned farms unless they hold an admin/GM
    role (see ``_allowed_farms_for``)."""
    _check_perm()

    allowed = _allowed_farms_for()

    # Mapped chemical/fertilizer stores across the caller's IN-SCOPE farms —
    # ALL farms for admin/GM (``allowed is None``), else only the farms the
    # caller is assigned to. These are the only warehouses the "Chemical
    # Stores"/"Fertilizer Stores" panels may total, for every role.
    farm_filter = None if allowed is None else {"name": ("in", allowed or ["__no_farm__"])}
    farm_rows = frappe.get_all(
        "Farm", filters=farm_filter,
        fields=["custom_chemical_store", "custom_fertilizer_store"],
    )
    chem_stores = {f.custom_chemical_store for f in farm_rows if f.custom_chemical_store}
    fert_stores = {f.custom_fertilizer_store for f in farm_rows if f.custom_fertilizer_store}

    allowed_whs = None
    if allowed is not None:
        # ``allowed`` may be an empty list (no farms assigned) — don't let an
        # empty IN-clause sentinel accidentally match warehouses whose
        # ``custom_farm`` is itself an empty string/null.
        allowed_whs = (
            frappe.get_all("Warehouse", filters={"custom_farm": ("in", allowed)}, pluck="name")
            if allowed
            else []
        )

    # The chemical + foliar groups configured on Scouting and Crop Protection
    # Settings, resolved per call so a group added on the settings Chemicals tab
    # reaches this dashboard without a code change or a restart. Empty means
    # nothing is configured — bail out rather than emit an `IN ()`.
    dashboard_groups = product_groups()

    if allowed_whs == [] or not dashboard_groups:
        buckets = bucket_overview([], _chemical_group_items(), chem_stores, fert_stores)
        return {
            "items": [],
            "warehouses": [],
            "matrix": [],
            "csus": [],
            "as_of": now_datetime().isoformat(timespec="seconds"),
            "buckets": buckets,
            "allowed_farms": allowed,
        }

    bin_params = {"groups": dashboard_groups}
    wh_filter_sql = ""
    if allowed_whs is not None:
        wh_filter_sql = "AND  b.warehouse IN %(allowed_whs)s"
        bin_params["allowed_whs"] = tuple(allowed_whs)

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code,
               i.item_name,
               i.item_group,
               COALESCE(i.stock_uom, '') AS uom,
               b.warehouse,
               b.actual_qty
        FROM   `tabBin`  b
        JOIN   `tabItem` i ON i.name = b.item_code
        WHERE  i.item_group IN %(groups)s
          AND  b.actual_qty > 0
          {wh_filter_sql}
        ORDER  BY i.item_name, b.warehouse
        """,
        bin_params,
        as_dict=True,
    )

    items: dict = {}
    warehouses: dict = {}
    matrix: list = []
    for r in rows:
        qty = float(r["actual_qty"] or 0)
        if qty <= 0:
            continue
        ik = r["item_code"]
        wh = r["warehouse"]
        item_bucket = items.setdefault(
            ik,
            {
                "item_code": ik,
                "item_name": r["item_name"] or ik,
                "group":     r["item_group"],
                "uom":       r["uom"],
                "total_qty": 0.0,
            },
        )
        item_bucket["total_qty"] += qty
        wh_bucket = warehouses.setdefault(
            wh,
            {"warehouse": wh, "total_qty": 0.0, "item_count": 0},
        )
        wh_bucket["total_qty"] += qty
        wh_bucket["item_count"] += 1
        matrix.append(
            {"item_code": ik, "warehouse": wh, "qty": qty},
        )

    # Full CSU roster (every enabled, non-group CSU warehouse), independent of
    # whether it currently holds stock — lets the dashboard show all CSUs and
    # disable the empty ones. Pre-filtered to names containing "CSU"; the client
    # applies the exact whole-word rule.
    csu_params = {"p": "%CSU%"}
    csu_filter_sql = ""
    if allowed_whs is not None:
        csu_filter_sql = "AND  name IN %(allowed_whs)s"
        csu_params["allowed_whs"] = tuple(allowed_whs)

    csus = frappe.db.sql(
        f"""
        SELECT name AS warehouse, COALESCE(custom_farm, '') AS farm
        FROM   `tabWarehouse`
        WHERE  is_group = 0 AND disabled = 0 AND name LIKE %(p)s
          {csu_filter_sql}
        ORDER  BY name
        """,
        csu_params,
        as_dict=True,
    )

    items_list = sorted(items.values(), key=lambda x: -x["total_qty"])
    warehouses_list = sorted(warehouses.values(), key=lambda x: -x["total_qty"])
    chem_items = _chemical_group_items()
    buckets = bucket_overview(matrix, chem_items, chem_stores, fert_stores)

    return {
        "items":         items_list,
        "warehouses":    warehouses_list,
        "matrix":        matrix,
        "csus":          csus,
        "as_of":         now_datetime().isoformat(timespec="seconds"),
        "buckets":       buckets,
        "allowed_farms": allowed,
    }


def _store_level_bucket(stores: list, kind: str) -> dict:
    """Given ``stores`` = [{warehouse, farm, label}, ...] for one bucket
    (chemical or fertilizer), aggregate Bin stock for that ``kind``'s configured
    item groups into the ``items``/``matrix`` shape the comparison UI consumes.
    Only the listed warehouses are ever queried, so anything not mapped as a
    farm's store (e.g. a CSU) is inherently excluded."""
    groups = product_groups(kind)
    if not stores or not groups:
        return {"stores": stores, "items": [], "matrix": []}

    names = [s["warehouse"] for s in stores]
    rows = frappe.db.sql(
        """SELECT b.item_code, b.warehouse, b.actual_qty AS qty,
                  i.item_name, COALESCE(i.stock_uom, '') AS uom
           FROM `tabBin` b JOIN `tabItem` i ON i.name = b.item_code
           WHERE b.warehouse IN %(w)s AND i.item_group IN %(grp)s AND b.actual_qty > 0""",
        {"w": tuple(names), "grp": groups},
        as_dict=True,
    )

    items: dict = {}
    matrix = []
    for r in rows:
        bucket = items.setdefault(r.item_code, {
            "item_code": r.item_code,
            "item_name": r.item_name or r.item_code,
            "uom": r.uom,
            "total": 0.0,
        })
        bucket["total"] += float(r.qty)
        matrix.append({"item_code": r.item_code, "warehouse": r.warehouse, "qty": float(r.qty)})

    return {
        "stores": stores,
        "items": sorted(items.values(), key=lambda x: -x["total"]),
        "matrix": matrix,
    }


@frappe.whitelist()
def farm_store_levels() -> dict:
    """Comparative chemical/fertilizer levels across each ASSIGNED FARM's
    MAPPED store — ``Farm.custom_chemical_store`` / ``custom_fertilizer_store``
    — not name-matched warehouses.

    Powers the Chemical Dashboard's farm-comparison view. One farm = one
    mapped store per bucket; farms without that mapping are omitted, and
    since only mapped stores are ever queried, CSUs never appear.

    Returns:
      {
        "chemical":    {stores, items, matrix},
        "fertilizer":  {stores, items, matrix},
        "allowed_farms": [...] | None,
      }

    Scoped to the caller's assigned farms unless they hold an admin/GM
    role (see ``_allowed_farms_for``)."""
    _check_perm()

    allowed = _allowed_farms_for()
    if allowed is None:
        farms = frappe.get_all(
            "Farm",
            fields=["name", "custom_chemical_store", "custom_fertilizer_store"],
        )
    elif allowed:
        farms = frappe.get_all(
            "Farm",
            filters={"name": ("in", allowed)},
            fields=["name", "custom_chemical_store", "custom_fertilizer_store"],
        )
    else:
        farms = []

    chemical_stores = [
        {"warehouse": f.custom_chemical_store, "farm": f.name, "label": f.name}
        for f in farms
        if f.custom_chemical_store
    ]
    fertilizer_stores = [
        {"warehouse": f.custom_fertilizer_store, "farm": f.name, "label": f.name}
        for f in farms
        if f.custom_fertilizer_store
    ]

    return {
        "chemical": _store_level_bucket(chemical_stores, "chemical"),
        "fertilizer": _store_level_bucket(fertilizer_stores, "foliar"),
        "allowed_farms": allowed,
    }


# ----------------------------------------------------------------------
# Spray Plan Transfers
# ----------------------------------------------------------------------
# Stock entries this page works with — matches the legacy script's
# filters so we stay backwards-compatible with the data set the
# operator already knows.
_SE_PURPOSE = "Material Transfer for Manufacture"


def _transfer_submit_error(row: dict) -> str | None:
    """Return why this transfer SE cannot be submitted, or None if it can.

    Pure — shared by both the biometric and the manual submit paths so
    the eligibility rules (draft, correct purpose, receiving employee
    assigned) never drift between them. Biometric identity matching is
    NOT checked here; that is specific to the biometric path.

    ``row`` keys: name, docstatus, purpose, bio_employee.
    """
    name = row.get("name")
    if row.get("docstatus") != 0:
        return f"{name}: already submitted or cancelled."
    if (row.get("purpose") or "") != _SE_PURPOSE:
        return f"{name}: purpose is not {_SE_PURPOSE}."
    if not row.get("bio_employee"):
        return f"{name}: no receiving employee assigned — assign one first."
    return None


_AFP_TYPE = "Application Floor Plan"


@frappe.whitelist()
def get_transfer_items(name: str) -> dict:
    """Items on a single draft Stock Entry — used by the Transfers page
    chemical drop-down. Trimmed to the columns the UI actually shows so
    the round-trip stays small even when a SE has 30 line items."""
    _check_perm()
    name = (name or "").strip()
    if not name:
        return {"items": []}
    rows = frappe.db.sql(
        """
        SELECT it.item_code, it.item_name, it.qty, it.uom, it.s_warehouse,
               it.t_warehouse
        FROM   `tabStock Entry Detail` it
        WHERE  it.parent = %(name)s
        ORDER  BY it.idx
        """,
        {"name": name},
        as_dict=True,
    )
    return {"items": [
        {
            "item_code":     r["item_code"],
            "item_name":     r["item_name"] or r["item_code"],
            "qty":           float(r["qty"] or 0),
            "uom":           r["uom"] or "",
            "from_warehouse": r["s_warehouse"] or "",
            "to_warehouse":   r["t_warehouse"] or "",
        }
        for r in rows
    ]}


@frappe.whitelist()
def search_employees(query: str = "", limit: int = 12) -> list:
    """Employee autocomplete for the Transfers bulk-assign picker.
    Matches against employee id, name, or designation. Returns up to
    ``limit`` rows sorted by relevance (id startswith > name contains)."""
    _check_perm()
    q = (query or "").strip()
    try:
        limit = max(1, min(int(limit or 12), 50))
    except (TypeError, ValueError):
        limit = 12
    if not q:
        rows = frappe.db.sql(
            """
            SELECT name AS employee, employee_name, designation, department
            FROM   `tabEmployee`
            WHERE  status = 'Active'
            ORDER  BY employee_name
            LIMIT  %(limit)s
            """,
            {"limit": limit},
            as_dict=True,
        )
        return rows
    like = f"%{q}%"
    rows = frappe.db.sql(
        """
        SELECT name AS employee, employee_name, designation, department,
               CASE WHEN name LIKE %(prefix)s THEN 0
                    WHEN employee_name LIKE %(prefix)s THEN 1
                    ELSE 2 END AS score
        FROM   `tabEmployee`
        WHERE  status = 'Active'
          AND  (name LIKE %(like)s
                OR employee_name LIKE %(like)s
                OR designation LIKE %(like)s)
        ORDER  BY score, employee_name
        LIMIT  %(limit)s
        """,
        {"like": like, "prefix": f"{q}%", "limit": limit},
        as_dict=True,
    )
    return rows


@frappe.whitelist()
def bulk_assign_employee(names: str | list, employee: str) -> dict:
    """Set ``bio_employee`` on every Stock Entry in ``names`` to the given
    ``employee`` (a single receiving employee per entry; the new upande_ta
    model uses a direct field, not a child table).

    The submit step expects exactly one employee row per SE, so this
    is the deliberate side door the operator uses to prepare a batch
    for one biometric scan."""
    _check_perm()
    employee = (employee or "").strip()
    if not employee:
        frappe.throw("Missing employee.", frappe.ValidationError)
    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (ValueError, TypeError):
            names = [n.strip() for n in names.split(",") if n.strip()]
    if not isinstance(names, list) or not names:
        frappe.throw("No Stock Entries selected.", frappe.ValidationError)

    emp_doc = frappe.db.get_value(
        "Employee", employee, ["name", "employee_name"], as_dict=True,
    )
    if not emp_doc:
        frappe.throw(f"Employee {employee!r} not found.", frappe.ValidationError)

    ok_count = 0
    failed_count = 0
    results: list = []
    for name in names:
        try:
            doc = frappe.get_doc("Stock Entry", name)
            if doc.docstatus != 0:
                raise frappe.ValidationError(
                    f"{name}: already submitted or cancelled.",
                )
            # Assign the receiving employee directly (new upande_ta model:
            # a single bio_employee field, not a child table). Reset any prior
            # verification so a re-assign forces a fresh scan.
            doc.bio_employee = emp_doc["name"]
            doc.bio_employee_name = emp_doc["employee_name"]
            doc.biometric_status = "Pending"
            doc.biometric_verified_at = None
            doc.matched_biometric_log = None
            # Stock Entry.department has fetch_from=bio_employee.department
            # (upande_ta). On sites where the Department master is unrestored,
            # Employee.department links dangle and that fetch pulls a
            # non-existent Department, failing link validation on save. The
            # department is incidental to CSU transfers, so skip link
            # validation the same way auto_material_issue does.
            doc.flags.ignore_links = True
            doc.save(ignore_permissions=False)
            ok_count += 1
            results.append({"name": name, "ok": True, "error": None})
        except Exception as e:
            failed_count += 1
            results.append({"name": name, "ok": False, "error": str(e)})
            frappe.db.rollback()

    frappe.db.commit()
    return {
        "ok":      ok_count,
        "failed":  failed_count,
        "results": results,
        "employee": emp_doc,
    }


@frappe.whitelist()
def list_draft_transfers(
    farm: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict:
    """Return draft Material-Transfer-for-Manufacture Stock Entries
    whose work order is an Application Floor Plan.

    Output rows include enough context for the React table — date,
    work order, target warehouse, employee assignment, item count and
    the per-SE total quantity to be moved.

    Optional ``farm`` filters to a single farm (matched against the
    work order's ``custom_farm``). Date filters use the SE's
    ``posting_date``."""
    _check_perm()

    where = ["se.docstatus = 0", "se.purpose = %(purpose)s", "se.work_order IS NOT NULL"]
    params: dict = {"purpose": _SE_PURPOSE}
    if from_date:
        where.append("se.posting_date >= %(from_date)s")
        params["from_date"] = from_date
    if to_date:
        where.append("se.posting_date <= %(to_date)s")
        params["to_date"] = to_date

    sql_where = " AND ".join(where)
    # Farm is derived from the destination Warehouse (Warehouse.custom_farm)
    # — Work Order itself has no farm field on this site.
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.posting_date, se.work_order,
               se.from_warehouse, se.to_warehouse,
               COALESCE(tw.custom_farm, fw.custom_farm, '') AS farm,
               (SELECT SUM(it.qty)
                FROM   `tabStock Entry Detail` it
                WHERE  it.parent = se.name)                    AS total_qty,
               (SELECT COUNT(*)
                FROM   `tabStock Entry Detail` it
                WHERE  it.parent = se.name)                    AS item_count
        FROM   `tabStock Entry` se
        JOIN   `tabWork Order`  wo ON wo.name = se.work_order
        LEFT   JOIN `tabWarehouse` tw ON tw.name = se.to_warehouse
        LEFT   JOIN `tabWarehouse` fw ON fw.name = se.from_warehouse
        WHERE  {sql_where}
          AND  wo.custom_type = %(afp)s
        ORDER  BY se.posting_date DESC, se.creation DESC
        """,
        {**params, "afp": _AFP_TYPE},
        as_dict=True,
    )

    if farm:
        rows = [r for r in rows if (r.get("farm") or "") == farm]

    # Employee assignment (bio_employee) is the only thing the bulk submit
    # needs server-side to validate the biometric. Pull it in one query so a
    # 50-draft list doesn't fire 50 sub-queries.
    names = [r["name"] for r in rows]
    emp_by_se: dict = {}
    if names:
        emp_rows = frappe.db.sql(
            """
            SELECT name AS parent, bio_employee AS employee,
                   bio_employee_name AS employee_name
            FROM   `tabStock Entry`
            WHERE  name IN %(names)s
              AND  bio_employee IS NOT NULL AND bio_employee != ''
            """,
            {"names": names},
            as_dict=True,
        )
        for er in emp_rows:
            emp_by_se[er["parent"]] = [
                {"employee": er["employee"], "employee_name": er["employee_name"]},
            ]

    for r in rows:
        r["employees"] = emp_by_se.get(r["name"], [])
        r["total_qty"] = float(r["total_qty"] or 0)
        r["item_count"] = int(r["item_count"] or 0)

    farms = sorted({r["farm"] for r in rows if r.get("farm")})
    return {
        "rows": rows,
        "farms": farms,
        "allow_submit_without_biometric": _allow_submit_without_biometric(),
    }


# ----------------------------------------------------------------------
# Labels page — submitted transfers + their QR attachments
# ----------------------------------------------------------------------


@frappe.whitelist()
def list_submitted_transfers(
    farm: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict:
    """Submitted Material-Transfer-for-Manufacture Stock Entries — the
    dataset the Labels page picks from to print QR stickers.

    Shape mirrors ``list_draft_transfers`` (same row columns + farms
    list) so the React selection tree and filter bar can reuse the
    existing types. The only behavioural difference: we filter for
    docstatus=1 and surface an ``has_qr`` flag derived from whether
    each SE has at least one image attachment — printing a label for
    an SE without a QR file is meaningless, so the UI dims those rows.

    Optional ``farm`` filters to one farm. Date filters use posting_date."""
    _check_perm()

    where = ["se.docstatus = 1", "se.purpose = %(purpose)s", "se.work_order IS NOT NULL"]
    params: dict = {"purpose": _SE_PURPOSE}
    if from_date:
        where.append("se.posting_date >= %(from_date)s")
        params["from_date"] = from_date
    if to_date:
        where.append("se.posting_date <= %(to_date)s")
        params["to_date"] = to_date

    sql_where = " AND ".join(where)
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.posting_date, se.work_order,
               se.from_warehouse, se.to_warehouse,
               se.custom_labels_printed AS labels_printed,
               se.custom_labels_print_count AS labels_print_count,
               se.custom_labels_printed_on AS labels_printed_on,
               se.custom_labels_printed_by AS labels_printed_by,
               se.biometric_status AS biometric_status,
               COALESCE(tw.custom_farm, fw.custom_farm, '') AS farm,
               wo.custom_greenhouse AS greenhouse,
               wo.custom_spray_type AS spray_type,
               (SELECT SUM(it.qty)
                FROM   `tabStock Entry Detail` it
                WHERE  it.parent = se.name)                    AS total_qty,
               (SELECT COUNT(*)
                FROM   `tabStock Entry Detail` it
                WHERE  it.parent = se.name)                    AS item_count
        FROM   `tabStock Entry` se
        JOIN   `tabWork Order`  wo ON wo.name = se.work_order
        LEFT   JOIN `tabWarehouse` tw ON tw.name = se.to_warehouse
        LEFT   JOIN `tabWarehouse` fw ON fw.name = se.from_warehouse
        WHERE  {sql_where}
          AND  wo.custom_type = %(afp)s
        ORDER  BY se.posting_date DESC, se.creation DESC
        """,
        {**params, "afp": _AFP_TYPE},
        as_dict=True,
    )

    if farm:
        rows = [r for r in rows if (r.get("farm") or "") == farm]

    # QR availability flag + a representative URL the Labels page can
    # render in the live preview. Pull every File attached to these SEs
    # and filter to images in Python — mirrors what
    # ``spray_plan_labels._collect_labels`` does when picking QRs for
    # the PDF, so the listing never disagrees with the renderer. A
    # SQL ``file_name LIKE '%.png'`` filter misses rows where the File
    # has only ``file_url`` populated (or odd casing), even though the
    # renderer would still pick them up.
    qr_counts: dict = {}
    qr_urls: dict = {}
    names = [r["name"] for r in rows]
    if names:
        image_exts = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
        public_root = frappe.get_site_path("public", "files")
        private_root = frappe.get_site_path("private", "files")
        file_rows = frappe.get_all(
            "File",
            filters={
                "attached_to_doctype": "Stock Entry",
                "attached_to_name": ("in", names),
            },
            fields=["attached_to_name", "file_url", "file_name", "creation"],
            order_by="attached_to_name, creation",
        )
        for fr in file_rows:
            # Fall back to the URL when ``file_name`` is missing — some
            # File docs only persist ``file_url``, and the renderer
            # tolerates that, so the listing should too.
            name_for_ext = (fr.get("file_name") or fr.get("file_url") or "").lower()
            if not name_for_ext.endswith(image_exts):
                continue
            # File doc can exist without the underlying bytes on disk —
            # the PDF renderer skips those, so the listing must too, or
            # the operator picks a row that looks printable but isn't.
            file_url = fr.get("file_url") or ""
            if file_url.startswith("/private/files/"):
                disk_path = os.path.join(private_root, file_url[len("/private/files/"):])
            elif file_url.startswith("/files/"):
                disk_path = os.path.join(public_root, file_url[len("/files/"):])
            else:
                disk_path = ""
            if not disk_path or not os.path.isfile(disk_path):
                continue
            se_name = fr["attached_to_name"]
            qr_counts[se_name] = qr_counts.get(se_name, 0) + 1
            # First-seen URL per SE wins. Earliest by creation order, so
            # the preview shows whichever QR was generated first.
            qr_urls.setdefault(se_name, file_url)

    for r in rows:
        r["total_qty"] = float(r["total_qty"] or 0)
        r["item_count"] = int(r["item_count"] or 0)
        r["qr_count"] = qr_counts.get(r["name"], 0)
        r["has_qr"] = r["qr_count"] > 0
        r["qr_image_url"] = qr_urls.get(r["name"], "")
        r["labels_printed"] = bool(r.get("labels_printed"))
        r["labels_print_count"] = int(r.get("labels_print_count") or 0)
        r["labels_printed_on"] = str(r["labels_printed_on"]) if r.get("labels_printed_on") else ""
        r["labels_printed_by"] = r.get("labels_printed_by") or ""
        r["biometric_status"] = r.get("biometric_status") or "Pending"

    farms = sorted({r["farm"] for r in rows if r.get("farm")})
    return {"rows": rows, "farms": farms}


# ----------------------------------------------------------------------
# Bulk biometric submit
# ----------------------------------------------------------------------
# The frontend has already called ``verify_employee`` (below) to get the
# scanned employee identity. We re-fetch the latest Biometric Logs row
# here as a freshness check — a curl-only attacker can't forge a scan
# because the row has to exist in the last couple of minutes, and the
# device hardware is the only source that writes it.
#
# The doctype's scan-time field is ``time`` (label "Timestamp"). Any
# ``log_type`` counts as a scan — the newest row in the window wins.
#
# The window is NOT hardcoded here — it honours upande_ta's single source
# of truth, ``Biometric Setting.stock_verification_window_minutes``, so
# scp's explicit store-keeper path and ta's background auto-verify path
# agree on how fresh a scan must be. Falls back to ta's own default when
# the setting is empty/zero.
_DEFAULT_VERIFY_WINDOW_MINUTES = 1


def _verify_window_seconds() -> int:
    """Scan freshness window (seconds), read from Biometric Setting so it
    stays coherent with upande_ta. Falls back to the ta default."""
    try:
        value = frappe.db.get_single_value(
            "Biometric Setting", "stock_verification_window_minutes"
        )
    except Exception:
        value = None
    minutes = int(value) if value and int(value) > 0 else _DEFAULT_VERIFY_WINDOW_MINUTES
    return minutes * 60


def _latest_biometric_log() -> dict | None:
    threshold = add_to_date(now_datetime(), seconds=-_verify_window_seconds())
    rows = frappe.db.sql(
        """
        SELECT name, employee, employee_name, biometric_id, `time`
        FROM   `tabBiometric Logs`
        WHERE  `time` > %(t)s
        ORDER  BY `time` DESC
        LIMIT  1
        """,
        {"t": threshold},
        as_dict=True,
    )
    return rows[0] if rows else None


@frappe.whitelist()
def verify_employee() -> dict:
    """Return the most recent biometric scan for the 'place your finger'
    UX prompt the frontend shows before ``submit_with_biometric``.

    scp's own copy of the verify step — the logic lives here in code
    instead of in a site-stored Desk Server Script, so the page has no
    external dependency. Mirrors that script's response shape so the
    frontend treats it as a drop-in: the log row on success, or
    ``{"error": ...}`` when no fresh scan exists."""
    _check_perm()
    scan = _latest_biometric_log()
    if scan:
        return scan
    return {"error": "Please place finger on the Biometric Device"}


@frappe.whitelist()
def submit_with_biometric(names: str | list) -> dict:
    """Authorise + submit each Stock Entry in ``names`` against the
    most recent biometric scan.

    Per-SE validation:
      * SE must exist and be a draft Material Transfer for Manufacture.
      * SE must have a ``bio_employee`` assigned.
      * The scanned employee must match ``bio_employee``.
      * Mark ``biometric_status = Verified`` (+ verified_at / matched log).
      * Save, then submit.

    Returns ``{ok: int, failed: int, results: [{name, ok, error}]}``.
    A single failure in the loop doesn't abort the others — the
    operator sees a per-row outcome and retries only the failures."""
    _check_perm()

    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (ValueError, TypeError):
            names = [n.strip() for n in names.split(",") if n.strip()]
    if not isinstance(names, list) or not names:
        frappe.throw("No Stock Entries selected.", frappe.ValidationError)

    scan = _latest_biometric_log()
    if not scan:
        window_min = _verify_window_seconds() // 60
        frappe.throw(
            f"No biometric scan in the last {window_min} "
            f"minute{'s' if window_min != 1 else ''} — please place "
            "your finger on the device and try again.",
            frappe.ValidationError,
        )

    scanned_emp = scan["employee"]
    scanned_name = scan["employee_name"]
    biometric_id = scan["biometric_id"]
    results: list = []
    ok_count = 0
    failed_count = 0

    for name in names:
        try:
            doc = frappe.get_doc("Stock Entry", name)
            err = _transfer_submit_error({
                "name": name,
                "docstatus": doc.docstatus,
                "purpose": doc.purpose,
                "bio_employee": doc.bio_employee,
            })
            if err:
                raise frappe.ValidationError(err)

            expected = doc.bio_employee
            expected_name = doc.bio_employee_name or expected
            if expected != scanned_emp:
                raise frappe.ValidationError(
                    f"{name}: biometric belongs to {scanned_name} but "
                    f"the entry is assigned to {expected_name}.",
                )

            # New upande_ta model: mark verified via direct fields (no
            # biometric_data child table).
            doc.bio_employee = scanned_emp
            doc.biometric_status = "Verified"
            doc.biometric_verified_at = now_datetime()
            if scan.get("name"):
                doc.matched_biometric_log = scan["name"]
            # Skip link validation (dangling Employee.department fetched onto
            # Stock Entry.department where the Department master is unrestored;
            # see assign_biometric_employee).
            doc.flags.ignore_links = True
            doc.save(ignore_permissions=False)
            doc.submit()
            ok_count += 1
            results.append({"name": name, "ok": True, "error": None})
        except Exception as e:
            failed_count += 1
            results.append({"name": name, "ok": False, "error": str(e)})
            # Rollback the failed save attempt; the loop continues on
            # the remaining SEs without leaving a half-saved doc behind.
            frappe.db.rollback()

    frappe.db.commit()
    return {
        "ok":      ok_count,
        "failed":  failed_count,
        "results": results,
        "scanned": {
            "employee":      scanned_emp,
            "employee_name": scanned_name,
            "biometric_id":  biometric_id,
        },
        "method": "biometric",
    }


def _allow_submit_without_biometric() -> bool:
    """Whether the GM has enabled the biometric-bypass fallback."""
    try:
        return bool(
            frappe.db.get_single_value(
                "Scouting and Crop Protection Settings", "allow_submit_without_biometric"
            )
        )
    except Exception:
        return False


@frappe.whitelist()
def get_submission_gating() -> dict:
    """Lightweight poll target so the store-keeper page can reflect a GM's
    biometric-gating toggle live, without a full page reload / re-fetch of
    the whole draft list."""
    _check_perm()
    return {"allow_submit_without_biometric": _allow_submit_without_biometric()}


@frappe.whitelist()
def submit_without_biometric(names: str | list) -> dict:
    """Submit each transfer SE in ``names`` WITHOUT a biometric scan.

    Gated behind ``Scouting and Crop Protection Settings.allow_submit_without_biometric`` —
    throws if a manager has not enabled it. Shares eligibility validation
    with the biometric path via ``_transfer_submit_error`` but performs no
    scan check and sets no verification fields itself. In the intended
    device-down case no fresh scan exists, so ``biometric_status`` stays
    "Pending" with no ``matched_biometric_log`` and the SE reads as manual.
    (``doc.save()`` still runs upande_ta's ``auto_verify_biometric`` validate
    hook; if a fresh matching scan happens to exist it will legitimately mark
    the SE Verified — which is correct, that IS a biometric authorisation.)
    The submitting user is captured by Frappe's built-in ``modified_by``.

    Returns ``{ok, failed, results, method}`` — same shape as the biometric
    path minus ``scanned`` (there was no scan), plus ``method="manual"``.
    """
    _check_perm()

    if not _allow_submit_without_biometric():
        frappe.throw(
            "Submitting without biometric is disabled. Ask a manager to "
            "enable it in Scouting and Crop Protection Settings → Submission Gating.",
            frappe.ValidationError,
        )

    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (ValueError, TypeError):
            names = [n.strip() for n in names.split(",") if n.strip()]
    if not isinstance(names, list) or not names:
        frappe.throw("No Stock Entries selected.", frappe.ValidationError)

    results: list = []
    ok_count = 0
    failed_count = 0

    for name in names:
        try:
            doc = frappe.get_doc("Stock Entry", name)
            err = _transfer_submit_error({
                "name": name,
                "docstatus": doc.docstatus,
                "purpose": doc.purpose,
                "bio_employee": doc.bio_employee,
            })
            if err:
                raise frappe.ValidationError(err)

            # No scan — set no verification fields here; the validate hook
            # leaves biometric_status "Pending" absent a fresh matching scan.
            # Skip link validation (dangling fetched department; see
            # assign_biometric_employee).
            doc.flags.ignore_links = True
            doc.save(ignore_permissions=False)
            doc.submit()
            ok_count += 1
            results.append({"name": name, "ok": True, "error": None})
        except Exception as e:
            failed_count += 1
            results.append({"name": name, "ok": False, "error": str(e)})
            frappe.db.rollback()

    frappe.db.commit()
    return {
        "ok": ok_count,
        "failed": failed_count,
        "results": results,
        "method": "manual",
    }
