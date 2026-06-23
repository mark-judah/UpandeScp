import frappe
from frappe import _
from frappe.utils import getdate, nowdate, add_days

no_cache = 1


def _safe_date(value):
    if not value:
        return None
    try:
        return getdate(value)
    except Exception:
        return None


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in to view this page."), frappe.PermissionError)

    today = getdate(nowdate())
    default_from = add_days(today, -30)

    raw_from = (frappe.form_dict.get("from") or "").strip()
    raw_to = (frappe.form_dict.get("to") or "").strip()
    farm = (frappe.form_dict.get("farm") or "").strip()
    greenhouse = (frappe.form_dict.get("greenhouse") or "").strip()
    status = (frappe.form_dict.get("status") or "").strip()

    date_from = _safe_date(raw_from) or default_from
    date_to = _safe_date(raw_to) or today

    filters = [
        ["Work Order", "custom_type", "=", "Application Floor Plan"],
        ["Work Order", "custom_scheduled_application_time", ">=", date_from],
        ["Work Order", "custom_scheduled_application_time", "<=", add_days(date_to, 1)],
    ]
    if greenhouse:
        filters.append(["Work Order", "custom_greenhouse", "=", greenhouse])

    if status == "pending":
        filters.append(["Work Order", "docstatus", "=", 0])
    elif status == "approved":
        filters.append(["Work Order", "docstatus", "=", 1])
    elif status == "cancelled":
        filters.append(["Work Order", "docstatus", "=", 2])

    fields = [
        "name",
        "production_item",
        "item_name",
        "qty",
        "stock_uom",
        "custom_greenhouse",
        "custom_variety",
        "custom_scope",
        "custom_spray_type",
        "custom_kit",
        "custom_scheduled_application_time",
        "custom_area",
        "docstatus",
        "owner",
        "creation",
    ]

    work_orders = frappe.get_list(
        "Work Order",
        filters=filters,
        fields=fields,
        order_by="custom_scheduled_application_time desc, creation desc",
        limit=200,
    )

    # Filter by farm using the cached greenhouse → farm mapping (custom_greenhouse
    # holds the warehouse name; the farm comes from its parent or label prefix).
    if farm:
        work_orders = [
            w for w in work_orders
            if w.get("custom_greenhouse")
            and (w["custom_greenhouse"].split(" - ")[-1] == farm or farm.lower() in (w["custom_greenhouse"] or "").lower())
        ]

    # Decorate with status info for the template.
    for w in work_orders:
        if w.get("docstatus") == 1:
            w["status_label"] = _("Approved")
            w["status_state"] = "approved"
        elif w.get("docstatus") == 2:
            w["status_label"] = _("Cancelled")
            w["status_state"] = "cancelled"
        else:
            w["status_label"] = _("Pending")
            w["status_state"] = "pending"

    # Greenhouse list — distinct values currently appearing on Application Floor
    # Plan work orders, so the filter only offers options that yield results.
    greenhouses = frappe.db.sql(
        """
        SELECT DISTINCT custom_greenhouse
        FROM `tabWork Order`
        WHERE custom_type = 'Application Floor Plan' AND custom_greenhouse IS NOT NULL AND custom_greenhouse != ''
        ORDER BY custom_greenhouse
        """,
        as_dict=True,
    )

    farms = sorted({(g.custom_greenhouse or "").split(" - ")[-1] for g in greenhouses if g.custom_greenhouse})

    context.no_cache = 1
    context.title = "Application Floor Plans"
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.work_orders = work_orders
    context.greenhouses = [g.custom_greenhouse for g in greenhouses]
    context.farms = [f for f in farms if f]
    context.filters = {
        "from": str(date_from),
        "to": str(date_to),
        "farm": farm,
        "greenhouse": greenhouse,
        "status": status,
    }
    return context
