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
