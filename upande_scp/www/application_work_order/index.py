import frappe
from frappe import _

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in to view this page."), frappe.PermissionError)

    name = (frappe.form_dict.get("name") or "").strip()
    if not name:
        frappe.throw(_("A work order name is required (?name=...)."), frappe.ValidationError)

    # Read Work Order (raises PermissionError automatically if user can't read it).
    wo = frappe.get_doc("Work Order", name)
    if (wo.get("custom_type") or "") != "Application Floor Plan":
        frappe.throw(
            _("This page only displays Application Floor Plan work orders."),
            frappe.ValidationError,
        )

    # Pull labels from the doctype meta so this page automatically reflects label
    # changes the team makes in the Work Order DocType (custom field renames etc.).
    meta = frappe.get_meta("Work Order")
    labels = {df.fieldname: (df.label or df.fieldname) for df in meta.fields if df.fieldname}

    def lbl(fieldname, fallback=None):
        return labels.get(fieldname) or fallback or fieldname

    work_order = wo.as_dict()

    # Chemical mix from the linked BOM. The BOM's custom_item_group is "Chemical Mix"
    # for application floor plans, so its exploded_items are the chemical components.
    bom = None
    chemical_mix_items = []
    if wo.bom_no:
        try:
            bom = frappe.get_doc("BOM", wo.bom_no)
            for ei in bom.get("exploded_items") or []:
                chemical_mix_items.append(ei.as_dict())
        except frappe.DoesNotExistError:
            bom = None

    # Required items as recorded on the work order itself (with availability and
    # source warehouse) — useful when BOM exploded items differ from required.
    required_items = [ri.as_dict() for ri in (wo.get("required_items") or [])]

    # Status banner: docstatus 0 = draft (awaiting approval), 1 = submitted (approved).
    if wo.docstatus == 1:
        status_label = _("Approved")
        status_state = "approved"
    elif wo.docstatus == 2:
        status_label = _("Cancelled")
        status_state = "cancelled"
    else:
        status_label = _("Awaiting approval")
        status_state = "pending"

    context.no_cache = 1
    context.title = name
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.work_order = work_order
    context.bom = bom.as_dict() if bom else None
    context.chemical_mix_items = chemical_mix_items
    context.required_items = required_items
    context.labels = labels
    context.lbl = lbl
    context.status_label = status_label
    context.status_state = status_state
    return context
