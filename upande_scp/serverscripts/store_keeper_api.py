"""Store-Keeper API — backs the two React pages in ``/scp_app``:

  * ``Chemical Dashboard``      → ``chemical_stock_overview``
  * ``Spray Plan Transfers``    → ``list_draft_transfers``,
                                  ``submit_with_biometric``

Permissions: every endpoint requires the ``Store Keeper`` role (System
Manager / Administrator still allowed for support / debugging). The
React sidebar gates the pages, but we re-check here so a curl call
from another session can't sneak past.

Biometric model uses mona's native flat Stock Entry fields
(``bio_employee`` / ``bio_employee_name`` / ``biometric_status`` /
``biometric_verified_at`` / ``matched_biometric_log``) rather than the
kaitet ``custom_employee_data`` / ``custom_biometric_data`` child tables
(those live in the unported ``upande_kaitet`` app). ``verify_employee``
reads the most recent ``Biometric Logs`` row from the last couple of
minutes and returns ``{employee, employee_name, biometric_id}``. The
frontend calls that once (UX prompt), then calls
``submit_with_biometric`` with the list of Stock Entry names to
authorise. We re-validate the scan freshness server-side, confirm the
scanned employee matches each SE's assigned ``bio_employee``, then mark
``biometric_status = Verified`` (with ``matched_biometric_log``) and
submit.
"""

import json
import os
from datetime import timedelta

import frappe
from frappe.utils import now_datetime, add_to_date


# ----------------------------------------------------------------------
# Permission gate
# ----------------------------------------------------------------------
_WRITE_ROLES = {"Store Keeper", "Stock Manager", "System Manager", "Administrator"}


def _check_perm():
    roles = set(frappe.get_roles(frappe.session.user) or [])
    if not (roles & _WRITE_ROLES):
        frappe.throw(
            "You need the Store Keeper or Stock Manager role to access this endpoint.",
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

    # Full CSU roster (every enabled, non-group CSU warehouse), independent of
    # whether it currently holds stock — lets the dashboard show all CSUs and
    # disable the empty ones. Pre-filtered to names containing "CSU"; the client
    # applies the exact whole-word rule.
    csus = frappe.db.sql(
        """
        SELECT name AS warehouse, COALESCE(custom_farm, '') AS farm
        FROM   `tabWarehouse`
        WHERE  is_group = 0 AND disabled = 0 AND name LIKE %(p)s
        ORDER  BY name
        """,
        {"p": "%CSU%"},
        as_dict=True,
    )

    return {
        "items":      sorted(items.values(), key=lambda x: -x["total_qty"]),
        "warehouses": sorted(warehouses.values(), key=lambda x: -x["total_qty"]),
        "matrix":     matrix,
        "csus":       csus,
        "as_of":      now_datetime().isoformat(timespec="seconds"),
    }


@frappe.whitelist()
def chemical_store_levels() -> dict:
    """Comparative chemical levels across each farm's chemical-store warehouse.

    Powers the Chemical Dashboard's farm-comparison view:
      * ``stores``  — one per ``Chemical Store *`` warehouse, with its farm and a
                      short display label.
      * ``items``   — chemicals in stock anywhere, with their grand total.
      * ``matrix``  — [{item_code, warehouse, qty}] for per-store / per-farm
                      aggregation client-side.

    Only the per-farm chemical stores are considered (greenhouse bins are
    excluded), so the comparison is store-to-store / farm-to-farm."""
    _check_perm()

    stores = frappe.get_all(
        "Warehouse",
        filters={
            "is_group": 0,
            "disabled": 0,
            "name": ("like", "Chemical Store%"),
            "custom_farm": ("is", "set"),
        },
        fields=["name", "custom_farm"],
        order_by="custom_farm, name",
    )
    if not stores:
        return {"stores": [], "items": [], "matrix": []}

    names = [s.name for s in stores]
    rows = frappe.db.sql(
        """SELECT b.item_code, b.warehouse, b.actual_qty AS qty,
                  i.item_name, COALESCE(i.stock_uom, '') AS uom
           FROM `tabBin` b JOIN `tabItem` i ON i.name = b.item_code
           WHERE b.warehouse IN %(w)s AND i.item_group IN %(g)s AND b.actual_qty > 0""",
        {"w": tuple(names), "g": _CHEMICAL_GROUPS},
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

    def _label(name: str) -> str:
        # "Chemical Store Kapkolia - KR" -> "Kapkolia - KR"
        return name.replace("Chemical Store", "").strip(" -") or name

    return {
        "stores": [
            {"warehouse": s.name, "farm": s.custom_farm, "label": _label(s.name)}
            for s in stores
        ],
        "items": sorted(items.values(), key=lambda x: -x["total"]),
        "matrix": matrix,
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
    """Assign ``employee`` as the receiving employee on every Stock Entry
    in ``names`` using mona's native biometric fields (``bio_employee`` /
    ``bio_employee_name`` / ``department``). Flags each SE as requiring
    biometric verification and resets its status to ``Pending`` so a
    stale prior verification can't carry over.

    The submit step matches the scanned identity against ``bio_employee``,
    so this is the deliberate side door the operator uses to prepare a
    batch for one biometric scan."""
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
        "Employee", employee, ["name", "employee_name", "department"], as_dict=True,
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
            doc.requires_biometric = 1
            doc.bio_employee = emp_doc["name"]
            doc.bio_employee_name = emp_doc["employee_name"]
            doc.department = emp_doc.get("department") or ""
            doc.biometric_status = "Pending"
            doc.biometric_verified_at = None
            doc.matched_biometric_log = None
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
               se.bio_employee, se.bio_employee_name,
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

    # Employee assignment now lives in mona's native flat fields on the
    # Stock Entry itself (``bio_employee`` / ``bio_employee_name``) rather
    # than a ``custom_employee_data`` child table. There is at most one
    # assigned employee per SE; surface it as a 0-or-1-element ``employees``
    # list so the React table's contract is unchanged.
    for r in rows:
        bio_emp = r.pop("bio_employee", None)
        bio_name = r.pop("bio_employee_name", None)
        r["employees"] = (
            [{"employee": bio_emp, "employee_name": bio_name or bio_emp}]
            if bio_emp
            else []
        )
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
               se.custom_labels_printed AS labels_printed,
               se.custom_labels_print_count AS labels_print_count,
               se.custom_labels_printed_on AS labels_printed_on,
               se.custom_labels_printed_by AS labels_printed_by,
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
_SCAN_FRESHNESS_SEC = 120


def _latest_biometric_log() -> dict | None:
    threshold = add_to_date(now_datetime(), seconds=-_SCAN_FRESHNESS_SEC)
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
      * SE must have an assigned ``bio_employee``.
      * The scanned employee must match ``bio_employee``.
      * Record the match in mona's native fields (``biometric_status`` =
        ``Verified``, ``biometric_verified_at``, ``matched_biometric_log``).
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
            expected = doc.bio_employee
            expected_name = doc.bio_employee_name or expected
            if not expected:
                raise frappe.ValidationError(
                    f"{name}: no receiving employee assigned — assign one "
                    f"before scanning.",
                )
            if expected != scanned_emp:
                raise frappe.ValidationError(
                    f"{name}: biometric belongs to {scanned_name} but "
                    f"the entry is assigned to {expected_name}.",
                )

            doc.requires_biometric = 1
            doc.biometric_status = "Verified"
            doc.biometric_verified_at = now_datetime()
            doc.matched_biometric_log = scan["name"]
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
