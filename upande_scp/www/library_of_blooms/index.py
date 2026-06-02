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


# Plain (free-text / select) fields copied straight through to the Lead.
_EOI_PLAIN = [
    "custom_request", "custom_business_unit", "first_name", "last_name", "job_title",
    "email_id", "mobile_no", "whatsapp_no", "custom_type_of_entity", "company_name",
    "custom_business_registration_number", "city", "custom_facebook", "custom_instagram", "website",
    "custom_billing_street_address", "custom_billing_street_address_2", "custom_billing_state_",
    "custom_billing_city", "custom_billing_postal_code",
    "custom_shipping_street_address", "custom_shipping_street_address_2", "custom_shipping_state",
    "custom_shipping_city", "custom_shipping_postal_code",
]
# Link fields set only if the linked record exists.
_EOI_LINKS = {
    "market_segment": "Market Segment", "territory": "Territory", "country": "Country",
    "custom_billing_country": "Country", "custom_shipping_country": "Country",
}


@frappe.whitelist(allow_guest=True)
def eoi_options():
    """Link-field choices for the Expression-of-Interest form (guest-safe)."""

    def names(dt):
        try:
            return frappe.get_all(dt, pluck="name", order_by="name asc")
        except Exception:
            return []

    return {
        "country": names("Country"),
        "market_segment": names("Market Segment"),
        "territory": names("Territory"),
    }


@frappe.whitelist(allow_guest=True)
def submit_interest(payload):
    """Create/update a Lead from the catalogue's Expression-of-Interest form.

    Captures the full set of Web Form fields (the 'expression-of-interest' form
    lands on Lead) plus the roses the visitor liked, on-brand and guest-safe.
    """
    data = json.loads(payload) if isinstance(payload, str) else (payload or {})
    meta = frappe.get_meta("Lead")
    has = lambda f: bool(meta.get_field(f))  # noqa: E731

    first = (data.get("first_name") or "").strip()
    last = (data.get("last_name") or "").strip()
    email = (data.get("email_id") or "").strip()
    mobile = (data.get("mobile_no") or "").strip()

    msg = (data.get("custom_message") or data.get("message") or "").strip()
    flowers = data.get("flowers") or []
    if isinstance(flowers, str):
        flowers = [f.strip() for f in flowers.split(",") if f.strip()]
    if flowers:
        msg = (msg + "\n\n" if msg else "") + "Roses of interest:\n" + "\n".join("  • " + f for f in flowers)

    def truthy(v):
        return 1 if v in (1, "1", True, "true", "on") else 0

    try:
        existing = frappe.db.get_value("Lead", {"email_id": email}, "name") if email else None
        doc = frappe.get_doc("Lead", existing) if existing else frappe.new_doc("Lead")

        for f in _EOI_PLAIN:
            if has(f) and (data.get(f) not in (None, "")):
                doc.set(f, data.get(f))
        for f, dt in _EOI_LINKS.items():
            if has(f) and data.get(f) and frappe.db.exists(dt, data.get(f)):
                doc.set(f, data.get(f))

        # Shipping == billing convenience (mirrors the Web Form client script).
        same = truthy(data.get("custom_same_as_billing"))
        if has("custom_same_as_billing"):
            doc.custom_same_as_billing = same
        if same:
            for b, s in [
                ("custom_billing_street_address", "custom_shipping_street_address"),
                ("custom_billing_street_address_2", "custom_shipping_street_address_2"),
                ("custom_billing_city", "custom_shipping_city"),
                ("custom_billing_state_", "custom_shipping_state"),
                ("custom_billing_postal_code", "custom_shipping_postal_code"),
            ]:
                if has(s) and doc.get(b):
                    doc.set(s, doc.get(b))
            if has("custom_shipping_country") and doc.get("custom_billing_country"):
                doc.custom_shipping_country = doc.get("custom_billing_country")

        # Computed / hidden fields.
        doc.lead_name = (first + " " + last).strip() or email or "Library of Blooms enquiry"
        if has("phone") and mobile:
            doc.phone = mobile
        if has("whatsapp_no") and not doc.get("whatsapp_no") and mobile:
            doc.whatsapp_no = mobile
        if has("custom_billing_address") and doc.get("custom_billing_street_address"):
            doc.custom_billing_address = doc.get("custom_billing_street_address")
        if has("custom_shipping_address") and doc.get("custom_shipping_street_address"):
            doc.custom_shipping_address = doc.get("custom_shipping_street_address")
        if has("custom_billing_street_address_type"):
            doc.custom_billing_street_address_type = "Billing"
        if has("custom_shipping_street_address_type"):
            doc.custom_shipping_street_address_type = "Shipping"
        if has("custom_business_unit") and not doc.get("custom_business_unit"):
            doc.custom_business_unit = "Roses"

        if has("custom_message"):
            if existing and (doc.get("custom_message") or "").strip():
                doc.custom_message = (doc.get("custom_message").strip() + "\n\n— New enquiry —\n" + msg).strip()
            else:
                doc.custom_message = msg

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
