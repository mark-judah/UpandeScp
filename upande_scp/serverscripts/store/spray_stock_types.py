"""Spray-flow Stock Entry Type names. Renaming these + the patch is the ONLY
place type wording lives. `purpose` (unchanged) is derived by ERPNext from the
type, so all purpose-based dispatch is unaffected."""

SE_TYPE_TRANSFER = "CSU Chemical Transfer"          # purpose: Material Transfer for Manufacture
SE_TYPE_MIX = "Chemical Mixing"                     # purpose: Manufacture
SE_TYPE_SPRAY = "Chemical Spray"                    # purpose: Material Issue
SE_TYPE_LOAN = "Chemical Loaning"                   # purpose: Material Transfer

# type name -> purpose (for the migrate patch)
SPRAY_STOCK_ENTRY_TYPES = {
    SE_TYPE_TRANSFER: "Material Transfer for Manufacture",
    SE_TYPE_MIX: "Manufacture",
    SE_TYPE_SPRAY: "Material Issue",
    SE_TYPE_LOAN: "Material Transfer",
}


def ensure_spray_stock_entry_types():
    """after_migrate: create the four Stock Entry Types the spray flow needs.

    There is a patch that does this too
    (``patches/v1_0/create_spray_stock_entry_types``) and it is not enough. On a
    **fresh install** Frappe never runs it: ``installer.install_app`` calls
    ``set_all_patches_as_completed(app)``, which marks every entry in
    ``patches.txt`` as done without executing any of them. That assumption holds
    for schema patches — a new site already has the end state — but a seed-data
    patch has no end state to inherit, so it silently produces nothing.

    The cost of that is not subtle. ``spray_plan_approval.approve_and_forward``
    sets ``stock_entry_type = "CSU Chemical Transfer"`` on the transfer it
    creates; the field is a Link, so with the type absent the whole approval
    fails. `kaitetv16-staging` had none of the four.

    Idempotent, and keeps ``purpose`` in sync if a type by the same name already
    exists — renaming a type in this module must never leave a stale purpose
    behind, because every downstream dispatch is purpose-based.
    """
    import frappe

    if not frappe.db.table_exists("Stock Entry Type"):
        return

    for type_name, purpose in SPRAY_STOCK_ENTRY_TYPES.items():
        if frappe.db.exists("Stock Entry Type", type_name):
            if frappe.db.get_value("Stock Entry Type", type_name, "purpose") != purpose:
                frappe.db.set_value("Stock Entry Type", type_name, "purpose", purpose)
            continue
        doc = frappe.new_doc("Stock Entry Type")
        doc.name = type_name
        doc.purpose = purpose
        doc.is_standard = 0
        doc.insert(ignore_permissions=True)
