import json

import frappe

# Public-facing botanical catalogue. Rendered as a fully self-contained
# document (it does NOT extend map_base.html), so there is no app sidebar
# or Frappe web chrome — just the immersive coffee-table page.
no_cache = 1


def get_context(context):
    context.no_cache = 1
    context.title = "Library of Blooms — Karen Roses"
    # CSRF token so the on-page Expression-of-Interest form can POST as a guest.
    context.csrf_token = frappe.sessions.get_csrf_token()
    # Intentionally no login guard: this is a client-facing showpiece meant
    # to be shareable. Wire up access control later if it goes fully public.
    return context


@frappe.whitelist(allow_guest=True)
def submit_interest(payload):
    """Create a Lead from the catalogue's Expression-of-Interest popup.

    Mirrors where the 'expression-of-interest' Web Form lands (doctype Lead),
    but captures only the essentials + the roses the visitor liked, so the
    experience stays light and on-brand. Bypasses the Web Form's long list of
    mandatory fields on purpose.
    """
    data = json.loads(payload) if isinstance(payload, str) else (payload or {})

    first = (data.get("first_name") or "").strip()
    last = (data.get("last_name") or "").strip()
    email = (data.get("email_id") or "").strip()
    phone = (data.get("mobile_no") or "").strip()
    country = (data.get("country") or "").strip()
    full_name = (first + " " + last).strip() or email or "Library of Blooms enquiry"

    # Compose the message, appending the liked varieties as a tidy list.
    msg = (data.get("message") or "").strip()
    flowers = data.get("flowers") or []
    if isinstance(flowers, str):
        flowers = [f.strip() for f in flowers.split(",") if f.strip()]
    if flowers:
        liked = "\n".join("  • " + f for f in flowers)
        msg = (msg + "\n\n" if msg else "") + "Roses of interest:\n" + liked

    meta = frappe.get_meta("Lead")
    has = lambda f: bool(meta.get_field(f))  # noqa: E731

    try:
        # If this email already expressed interest, append to that Lead instead
        # of failing on the unique-email constraint (Leads come back to us).
        existing = frappe.db.get_value("Lead", {"email_id": email}, "name") if email else None

        if existing:
            doc = frappe.get_doc("Lead", existing)
            if has("custom_message"):
                prev = (doc.get("custom_message") or "").strip()
                doc.custom_message = (prev + "\n\n— New enquiry —\n" + msg).strip() if prev else msg
            if phone and not doc.get("mobile_no"):
                doc.mobile_no = phone
            if data.get("custom_request") and has("custom_request"):
                doc.custom_request = data["custom_request"]
            if country and has("country") and not doc.get("country") and frappe.db.exists("Country", country):
                doc.country = country
        else:
            doc = frappe.new_doc("Lead")
            doc.lead_name = full_name
            if has("first_name") and first:
                doc.first_name = first
            if has("last_name") and last:
                doc.last_name = last
            if email:
                doc.email_id = email
            if phone:
                doc.mobile_no = phone
                if has("whatsapp_no"):
                    doc.whatsapp_no = phone
            if data.get("company_name") and has("company_name"):
                doc.company_name = data["company_name"]
            if data.get("custom_request") and has("custom_request"):
                doc.custom_request = data["custom_request"]
            if has("custom_business_unit"):
                doc.custom_business_unit = "Roses"
            if has("custom_message"):
                doc.custom_message = msg
            if country and has("country") and frappe.db.exists("Country", country):
                doc.country = country
            # Tag these enquiries with their own source so they're easy to filter.
            if has("source"):
                if frappe.db.exists("Lead Source", "Library of Blooms"):
                    doc.source = "Library of Blooms"
                elif frappe.db.exists("Lead Source", "Webform"):
                    doc.source = "Webform"

        doc.flags.ignore_mandatory = True
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        return {"ok": True, "name": doc.name}
    except Exception:
        frappe.db.rollback()
        frappe.log_error(frappe.get_traceback(), "Library of Blooms — submit_interest")
        return {"ok": False}


def _install_enquiry_report():
    """One-off: create the 'Library of Blooms Enquiries' saved Report-Builder
    view on Lead, and retag existing catalogue leads. Safe to re-run."""
    if not frappe.db.exists("Lead Source", "Library of Blooms"):
        frappe.get_doc({"doctype": "Lead Source", "source_name": "Library of Blooms"}).insert(ignore_permissions=True)

    # Retag any existing catalogue enquiry (liked roses recorded in the message).
    for name in frappe.get_all(
        "Lead",
        filters={"source": "Webform", "custom_message": ["like", "%Roses of interest%"]},
        pluck="name",
    ):
        frappe.db.set_value("Lead", name, "source", "Library of Blooms")

    rname = "Library of Blooms Enquiries"
    cfg = {
        "filters": [["Lead", "source", "=", "Library of Blooms"]],
        "columns": [
            ["lead_name", "Lead"], ["email_id", "Lead"], ["mobile_no", "Lead"],
            ["country", "Lead"], ["custom_request", "Lead"], ["custom_message", "Lead"],
            ["creation", "Lead"],
        ],
        "sort_by": "creation", "sort_order": "desc", "add_total_row": 0, "page_length": 50,
    }
    if frappe.db.exists("Report", rname):
        rep = frappe.get_doc("Report", rname)
        rep.json = json.dumps(cfg)
        rep.save(ignore_permissions=True)
    else:
        frappe.get_doc({
            "doctype": "Report", "report_name": rname, "ref_doctype": "Lead",
            "report_type": "Report Builder", "is_standard": "No",
            "module": "CRM", "json": json.dumps(cfg),
        }).insert(ignore_permissions=True)
    frappe.db.commit()
    return rname
