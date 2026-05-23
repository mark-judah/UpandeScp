"""Store-Keeper API — backs the two React pages in ``/scp_app``:

  * ``Chemical Dashboard``      → ``chemical_stock_overview``
  * ``Spray Plan Transfers``    → ``list_draft_transfers``,
                                  ``submit_with_biometric``

Permissions: every endpoint requires the ``Store Keeper`` role (System
Manager / Administrator still allowed for support / debugging). The
React sidebar gates the pages, but we re-check here so a curl call
from another session can't sneak past.

Biometric model mirrors the existing Material-Issue client script the
team already trusts: ``verify_employee`` (a server-side API script)
reads the most recent ``Biometric Logs`` row from the last minute and
returns ``{employee, employee_name, biometric_id}``. The frontend
calls that once, then calls ``submit_with_biometric`` with the scanned
identity + the list of Stock Entry names to authorise. We re-validate
the scan freshness server-side and write the result into each SE's
``custom_biometric_data`` child table before submitting.
"""

import json
from datetime import timedelta

import frappe
from frappe.utils import now_datetime, add_to_date


# ----------------------------------------------------------------------
# Permission gate
# ----------------------------------------------------------------------
_WRITE_ROLES = {"Store Keeper", "System Manager", "Administrator"}


def _check_perm():
    roles = set(frappe.get_roles(frappe.session.user) or [])
    if not (roles & _WRITE_ROLES):
        frappe.throw(
            "You need the Store Keeper role to access this endpoint.",
            frappe.PermissionError,
        )


# ----------------------------------------------------------------------
# Chemical Dashboard
# ----------------------------------------------------------------------
# Item groups treated as "chemicals" for the dashboard. Anything tagged
# with one of these (or having a descendant Item Group whose parent
# chain hits one of these) is included. Keep this small + explicit;
# adding new groups stays a deliberate config decision.
_CHEMICAL_GROUPS = ("CHEMICALS", "Fertilizer")


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
    for "only show chemicals in stock"."""
    _check_perm()

    rows = frappe.db.sql(
        """
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
        ORDER  BY i.item_name, b.warehouse
        """,
        {"groups": _CHEMICAL_GROUPS},
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

    return {
        "items":      sorted(items.values(), key=lambda x: -x["total_qty"]),
        "warehouses": sorted(warehouses.values(), key=lambda x: -x["total_qty"]),
        "matrix":     matrix,
        "as_of":      now_datetime().isoformat(timespec="seconds"),
    }


# ----------------------------------------------------------------------
# Spray Plan Transfers
# ----------------------------------------------------------------------
# Stock entries this page works with — matches the legacy script's
# filters so we stay backwards-compatible with the data set the
# operator already knows.
_SE_PURPOSE = "Material Transfer for Manufacture"
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
    """Set ``custom_employee_data`` on every Stock Entry in ``names`` to
    a single row pointing at ``employee``. Replaces whatever was there
    so multiple bulk-assigns don't pile up duplicates.

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
            doc.set("custom_employee_data", [])
            doc.append(
                "custom_employee_data",
                {
                    "employee":      emp_doc["name"],
                    "employee_name": emp_doc["employee_name"],
                },
            )
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

    # Employee assignment (custom_employee_data) is the only thing the
    # bulk submit needs server-side to validate the biometric. Pull it
    # in one query so a 50-draft list doesn't fire 50 sub-queries.
    names = [r["name"] for r in rows]
    emp_by_se: dict = {}
    if names:
        emp_rows = frappe.db.sql(
            """
            SELECT parent, employee, employee_name
            FROM   `tabEmployee Request`
            WHERE  parenttype = 'Stock Entry'
              AND  parentfield = 'custom_employee_data'
              AND  parent IN %(names)s
            ORDER  BY parent, idx
            """,
            {"names": names},
            as_dict=True,
        )
        for er in emp_rows:
            emp_by_se.setdefault(er["parent"], []).append(
                {"employee": er["employee"], "employee_name": er["employee_name"]},
            )

    for r in rows:
        r["employees"] = emp_by_se.get(r["name"], [])
        r["total_qty"] = float(r["total_qty"] or 0)
        r["item_count"] = int(r["item_count"] or 0)

    farms = sorted({r["farm"] for r in rows if r.get("farm")})
    return {"rows": rows, "farms": farms}


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
    # render in the live preview. One query for every SE in the result
    # set, joined to ``tabFile`` so we don't fire N round-trips.
    qr_counts: dict = {}
    qr_urls: dict = {}
    names = [r["name"] for r in rows]
    if names:
        img_rows = frappe.db.sql(
            """
            SELECT attached_to_name AS se_name,
                   file_url,
                   file_name,
                   creation
            FROM   `tabFile`
            WHERE  attached_to_doctype = 'Stock Entry'
              AND  attached_to_name IN %(names)s
              AND  (file_name LIKE %(jpg)s OR file_name LIKE %(jpeg)s
                    OR file_name LIKE %(png)s OR file_name LIKE %(webp)s
                    OR file_name LIKE %(gif)s OR file_name LIKE %(bmp)s)
            ORDER  BY attached_to_name, creation
            """,
            {
                "names": names,
                "jpg": "%.jpg", "jpeg": "%.jpeg", "png": "%.png",
                "webp": "%.webp", "gif": "%.gif", "bmp": "%.bmp",
            },
            as_dict=True,
        )
        for ir in img_rows:
            se_name = ir["se_name"]
            qr_counts[se_name] = qr_counts.get(se_name, 0) + 1
            # First-seen URL per SE wins. Earliest by creation order, so
            # the preview shows whichever QR was generated first.
            qr_urls.setdefault(se_name, ir["file_url"])

    for r in rows:
        r["total_qty"] = float(r["total_qty"] or 0)
        r["item_count"] = int(r["item_count"] or 0)
        r["qr_count"] = qr_counts.get(r["name"], 0)
        r["has_qr"] = r["qr_count"] > 0
        r["qr_image_url"] = qr_urls.get(r["name"], "")

    farms = sorted({r["farm"] for r in rows if r.get("farm")})
    return {"rows": rows, "farms": farms}


# ----------------------------------------------------------------------
# Bulk biometric submit
# ----------------------------------------------------------------------
# The frontend has already called ``verify_employee`` (server script in
# Upande Kaitet) to get the scanned employee identity. We re-fetch the
# latest Biometric Logs row here as a freshness check — a curl-only
# attacker can't forge a scan because the row has to exist in the last
# minute, and the device hardware is the only source that writes it.
_SCAN_FRESHNESS_SEC = 120  # be a touch more generous than the verify script


def _latest_biometric_log() -> dict | None:
    threshold = add_to_date(now_datetime(), seconds=-_SCAN_FRESHNESS_SEC)
    rows = frappe.db.sql(
        """
        SELECT employee, employee_name, biometric_id, timestamp
        FROM   `tabBiometric Logs`
        WHERE  timestamp > %(t)s
        ORDER  BY timestamp DESC
        LIMIT  1
        """,
        {"t": threshold},
        as_dict=True,
    )
    return rows[0] if rows else None


@frappe.whitelist()
def submit_with_biometric(names: str | list) -> dict:
    """Authorise + submit each Stock Entry in ``names`` against the
    most recent biometric scan.

    Per-SE validation:
      * SE must exist and be a draft Material Transfer for Manufacture.
      * SE's ``custom_employee_data`` must contain exactly one row.
      * The scanned employee must match that row.
      * Write the scanned identity to ``custom_biometric_data``.
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
        frappe.throw(
            "No biometric scan in the last 2 minutes — please place "
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
            if doc.docstatus != 0:
                raise frappe.ValidationError(
                    f"{name}: already submitted or cancelled.",
                )
            if (doc.purpose or "") != _SE_PURPOSE:
                raise frappe.ValidationError(
                    f"{name}: purpose is not {_SE_PURPOSE}.",
                )
            emp_rows = doc.get("custom_employee_data") or []
            if len(emp_rows) != 1:
                raise frappe.ValidationError(
                    f"{name}: needs exactly one Employee Data row "
                    f"(found {len(emp_rows)}).",
                )
            expected = emp_rows[0].employee
            expected_name = emp_rows[0].employee_name
            if expected != scanned_emp:
                raise frappe.ValidationError(
                    f"{name}: biometric belongs to {scanned_name} but "
                    f"the entry is assigned to {expected_name}.",
                )

            doc.set("custom_biometric_data", [])
            doc.append(
                "custom_biometric_data",
                {
                    "employee":      scanned_emp,
                    "employee_name": scanned_name,
                    "biometric_id":  biometric_id,
                },
            )
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
    }
